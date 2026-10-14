/**
 * Tier 3 resolution tests (Issue #562).
 *
 * Acceptance criteria:
 * 1. Decline / close / timeout → 0 API calls to readWithConsent.
 * 2. Passwords, CVV, and OTP elements → [SECRET]; size limit → handoff.
 * 3. Fabricated values, different-item values, masked card numbers → corroboration fails.
 * 4. Handler logs no body / values / site name (server-side tests in server.test.mjs).
 */

import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { buildTier3Payload, Tier3HandoffNeeded } from "../../extension/tier3-payload-builder.js";
import type { MaskedRegionItem } from "../../extension/content-script.js";
import { tier3PayloadJson, CLOUD_LIMITS } from "../../src/shared/cloud-contract.js";
import { ResolutionOrchestrator } from "../../extension/resolution-orchestrator.js";
import { CloudClient } from "../../extension/cloud-client.js";
import { VaultSession } from "../../src/store/vault-session.js";
import { FileVaultPersistence } from "../../src/store/file-vault-persistence.js";
import { secretCollectionItem } from "../../src/automation/ai-visibility-contract.js";
import type { CollectionItem } from "../../src/automation/collection-observation.js";

// ---------------------------------------------------------------------------
// Tier3PayloadBuilder
// ---------------------------------------------------------------------------

test("buildTier3Payload: basic happy path within size limit", () => {
  const items: MaskedRegionItem[] = [
    { id: "d-1", label: "メールアドレス", text: "fake@example.com" },
    { id: "d-2", label: "電話番号", text: "090-0000-0000" },
  ];
  const payload = buildTier3Payload("example.com", ["email", "phone.full"], items);
  assert.equal(payload.site, "example.com");
  assert.deepEqual(payload.requestedKeys, ["email", "phone.full"]);
  assert.equal(payload.items.length, 2);
  assert.equal(typeof payload.consentId, "string");
  // Must not exceed 16 KiB.
  assert.ok(new TextEncoder().encode(tier3PayloadJson(payload)).byteLength <= CLOUD_LIMITS.tier3Bytes);
});

test("buildTier3Payload: password element → throws Tier3HandoffNeeded(masking-failed)", () => {
  // An unmasked item near a password label should trigger the defense-in-depth check.
  const items: MaskedRegionItem[] = [
    { id: "f-1", label: "パスワード", text: "secret123" },
  ];
  assert.throws(() => buildTier3Payload("example.com", ["email"], items), Tier3HandoffNeeded);
  const err = (() => {
    try {
      buildTier3Payload("example.com", ["email"], items);
    } catch (e) {
      return e;
    }
  })() as Tier3HandoffNeeded;
  assert.equal(err.reason, "masking-failed");
});

test("buildTier3Payload: already-masked [SECRET] items pass through", () => {
  const items: MaskedRegionItem[] = [
    { id: "f-1", label: "パスワード", text: "[SECRET]" },
    { id: "d-1", label: "メールアドレス", text: "fake@example.com" },
  ];
  // Should not throw — the secret is already masked.
  const payload = buildTier3Payload("example.com", ["email"], items);
  // The masked item is still included as [SECRET] which is fine for context.
  assert.ok(payload.items.some((i) => i.text === "[SECRET]") || payload.items.some((i) => i.id === "d-1"));
});

test("buildTier3Payload: CVV-like digit pattern (3-4 digits) triggers masking-failed", () => {
  const items: MaskedRegionItem[] = [
    { id: "d-1", label: "メールアドレス", text: "fake@example.com" },
    { id: "d-2", text: "123" }, // naked 3-digit value, ambiguous
  ];
  // d-2 has a secret-shaped value and no confirming non-secret label → throws.
  assert.throws(() => buildTier3Payload("example.com", ["email"], items), Tier3HandoffNeeded);
});

test("buildTier3Payload: OTP-like 6-8 digit pattern triggers masking-failed", () => {
  const items: MaskedRegionItem[] = [
    { id: "d-1", text: "123456" }, // OTP-like
  ];
  assert.throws(() => buildTier3Payload("example.com", ["email"], items), Tier3HandoffNeeded);
});

test("buildTier3Payload: CVV label in any of the tested languages triggers masking-failed", () => {
  for (const label of ["CVV", "セキュリティコード", "security code", "認証コード", "OTP", "one-time code"]) {
    const items: MaskedRegionItem[] = [{ id: "d-1", label, text: "some-value" }];
    assert.throws(
      () => buildTier3Payload("example.com", ["email"], items),
      Tier3HandoffNeeded,
      `label: ${label}`,
    );
  }
});

test("buildTier3Payload: forbidden keys (account.password, card.cvv) → masking-failed", () => {
  const items: MaskedRegionItem[] = [{ id: "d-1", label: "メール", text: "fake@example.com" }];
  assert.throws(() => buildTier3Payload("example.com", ["account.password" as never], items), Tier3HandoffNeeded);
  assert.throws(() => buildTier3Payload("example.com", ["card.cvv" as never], items), Tier3HandoffNeeded);
});

test("buildTier3Payload: payload exceeding 16 KiB → payload-too-large", () => {
  // Each item has ~220 chars of text; 80 items × ~220 = ~17 600 chars > 16 KiB wire limit.
  // The text per item stays under CLOUD_LIMITS.text (4096) so the builder does not truncate it.
  // IDs start at 1 to satisfy the /^[fd]-[1-9][0-9]{0,5}$/ id pattern.
  const items: MaskedRegionItem[] = Array.from({ length: 80 }, (_, i) => ({
    id: `d-${i + 1}`,
    label: "メール",
    text: `fake-value-fake-value-fake-value-fake-value-fake-value-fake-value-fake-value-fake-value-fake-value-fake-value-fake-value-fake-value-fake-value-fake-value-fake-value-fake-value-${i + 1}`,
  }));
  const err = (() => {
    try {
      buildTier3Payload("example.com", ["email"], items);
    } catch (e) {
      return e;
    }
  })() as Tier3HandoffNeeded;
  assert.ok(err instanceof Tier3HandoffNeeded);
  assert.equal(err.reason, "payload-too-large");
});

test("buildTier3Payload: label truncated to 64 characters", () => {
  const longLabel = "メールアドレス".repeat(20); // > 64 chars
  const items: MaskedRegionItem[] = [{ id: "d-1", label: longLabel, text: "fake@example.com" }];
  const payload = buildTier3Payload("example.com", ["email"], items);
  assert.ok((payload.items[0]?.label?.length ?? 0) <= 64);
});

// ---------------------------------------------------------------------------
// Corroboration (via resolution-orchestrator internals)
// corroborateValue is private to ResolutionOrchestrator. Its effects are covered
// by the integration tests in soroeru-tier1-resolution.test.ts. The security
// properties verified here (masking-failed / payload-too-large) are the primary
// unit-level acceptance criteria for Issue #562.
// ---------------------------------------------------------------------------

test("Tier3PayloadBuilder: items with no text after masking are dropped", () => {
  const items: MaskedRegionItem[] = [
    { id: "d-1", text: "" },
    { id: "d-2", text: "   " },
    { id: "d-3", label: "メール", text: "fake@example.com" },
  ];
  const payload = buildTier3Payload("example.com", ["email"], items);
  // Only d-3 has non-empty text.
  assert.ok(payload.items.every((i) => i.text.trim().length > 0));
  assert.equal(payload.items.length, 1);
});

// ---------------------------------------------------------------------------
// Orchestrator: Tier 3 gate paths (finding B6)
// Tests verify: decline / close / timeout → 0 tier3Ticket / readWithConsent calls;
// corroboration rejects fabricated values, cross-item values, and masked PANs.
// ---------------------------------------------------------------------------

const T3_HASH = "c".repeat(64);

/** Schema with email (Tier 1 resolves) + phone.full (stays unresolved → triggers Tier 3). */
const T3_SCHEMA_PHONE = {
  schemaId: T3_HASH,
  site: "example.com",
  formKey: T3_HASH,
  version: 1,
  pageFingerprints: [T3_HASH],
  fields: [
    { anchor: "f-1", attributeKey: "email" as const, required: true },
    { anchor: "f-2", attributeKey: "phone.full" as const, required: true },
  ],
  confidence: 1 as const,
  status: "active" as const,
  provenance: "official" as const,
};

/** Schema variant where card.number is the unresolved field (for masked-PAN corroboration test). */
const T3_SCHEMA_CARD = {
  ...T3_SCHEMA_PHONE,
  schemaId: "d".repeat(64),
  formKey: "d".repeat(64),
  pageFingerprints: ["d".repeat(64)],
  fields: [
    { anchor: "f-1", attributeKey: "email" as const, required: true },
    { anchor: "f-2", attributeKey: "card.number" as const, required: true },
  ],
};

async function t3Session(t: TestContext) {
  const dir = await mkdtemp(join(tmpdir(), "t3-"));
  const path = join(dir, "vault.json");
  const s = new VaultSession({
    persistence: new FileVaultPersistence(path),
    kdfAlgo: "pbkdf2-sha512",
    lockManager: { tryAcquire: async () => ({ release() {} }) },
  });
  await s.start();
  await s.create("fake-test-passphrase-long");
  s.vault.put("cloudSettings", {
    id: "cloud",
    cloudAssistEnabled: true,
    telemetryEnabled: false,
    validatorKey: "fake-local-key",
    queue: [],
    updatedAt: 0,
  });
  t.after(async () => { s.close(); await rm(dir, { recursive: true, force: true }); });
  return s;
}

type ConsentDecision = "single" | "run" | "approved" | "declined" | "timeout";
type HttpScript = number | "network" | "budget" | "rate";

interface T3HarnessOptions {
  decisions?: ConsentDecision[];
  purposeHints?: Array<"profile" | "address" | "payment" | "contact" | "security" | "unknown">;
  unresolvedKeys?: string[];
  now?: () => number;
  isActive?: () => boolean;
  statuses?: HttpScript[];
  onRead?: () => void | Promise<void>;
  onGate?: () => void;
  gateCalls?: { count: number };
  fingerprint?: () => string;
}

/**
 * Build a ResolutionOrchestrator wired for Tier 3 tests.
 * Tier 2 is bypassed: the structureSnapshot returns only the already-resolved item (f-1),
 * which is filtered out, leaving empty items → tier2FallbackResult = tier1 → Tier 3 fires.
 */
function t3Orchestrator(
  session: VaultSession,
  schema: typeof T3_SCHEMA_PHONE | typeof T3_SCHEMA_CARD,
  calls: string[],
  consentDecision: ConsentDecision | ConsentDecision[],
  readWithConsentValues: { itemId: string; attributeKey: string; value: string }[],
  regionItems: MaskedRegionItem[],
  options: T3HarnessOptions = {},
) {
  const hash = schema.pageFingerprints[0]!;
  const decisions = options.decisions ?? (Array.isArray(consentDecision) ? consentDecision : [consentDecision]);
  let decisionIndex = 0;
  let hintIndex = 0;
  let httpIndex = 0;
  const gateCalls = options.gateCalls ?? { count: 0 };
  const httpResponse = (): Response | Promise<Response> => {
    const script = options.statuses?.[httpIndex++] ?? 200;
    if (script === "network") return Promise.reject(new TypeError("offline"));
    if (script === "budget") {
      return new Response(JSON.stringify({ error: "budget-exhausted" }), { status: 429 });
    }
    if (script === "rate") return new Response(JSON.stringify({ error: "rate-limited" }), { status: 429 });
    if (script !== 200) return new Response(JSON.stringify({ error: "unavailable" }), { status: script });
    return new Response(JSON.stringify({ ok: true }));
  };
  const client = new CloudClient(
    { apiBaseUrl: "https://api.example/", fallbackBaseUrl: "https://fallback.example/" },
    async (url) => {
      const urlStr = String(url);
      if (urlStr.endsWith("/resolve")) {
        calls.push("resolve");
        return new Response(JSON.stringify({ status: "active", schema }));
      }
      if (urlStr.endsWith("/tier3-ticket")) {
        calls.push("tier3-ticket");
        const response = await httpResponse();
        if (!response.ok) return response;
        return new Response(
          JSON.stringify({ ticket: "fakeheader.fakepayload", expiresAt: "2099-01-01T00:00:00.000Z" }),
        );
      }
      if (urlStr.endsWith("/read-with-consent")) {
        calls.push("read-with-consent");
        await options.onRead?.();
        const response = await httpResponse();
        if (!response.ok) return response;
        return new Response(JSON.stringify({ values: readWithConsentValues }));
      }
      calls.push(urlStr);
      const failed = await httpResponse();
      if (!failed.ok) return failed;
      return new Response(JSON.stringify({ mappings: [], pagePurpose: "contact" }));
    },
  );
  return new ResolutionOrchestrator({
    session,
    client,
    clientVersion: "0.1.2",
    isActive: options.isActive ?? (() => true),
    currentOrigin: "https://example.com",
    ...(options.now ? { now: options.now } : {}),
    showConsentGate: () => {
      gateCalls.count += 1;
      options.onGate?.();
      const decision = decisions[Math.min(decisionIndex, decisions.length - 1)] ?? "declined";
      decisionIndex += 1;
      return Promise.resolve(decision);
    },
    sendPageCommand: async (command) => {
      if (command.command === "schemaFingerprint") return options.fingerprint?.() ?? hash;
      if (command.command === "structureSnapshot") {
        const purposeHint = options.purposeHints?.[Math.min(hintIndex, (options.purposeHints?.length ?? 1) - 1)] ?? "unknown";
        hintIndex += 1;
        // Return one item; the resolved f-1 will be filtered out → empty → tier2FallbackResult
        return {
          site: "example.com",
          pageFingerprint: hash,
          purposeHint,
          items: [{ id: "f-1", tag: "input" as const, nameTokens: ["email"] }],
        };
      }
      if (command.command === "readSchema") {
        const keys = options.unresolvedKeys ?? [schema.fields[1]!.attributeKey];
        return {
          values: [{ itemId: "f-1", attributeKey: "email" as const, value: "fake@example.com" }],
          unresolved: keys.map((attributeKey) => ({ attributeKey, reason: "anchor-not-found" as const })),
        };
      }
      if (command.command === "readRegionMasked") {
        return { items: regionItems };
      }
      return null;
    },
  });
}

test("Tier 3 decline → 0 tier3Ticket / readWithConsent API calls", async (t) => {
  const session = await t3Session(t);
  const calls: string[] = [];
  const resolver = t3Orchestrator(
    session,
    T3_SCHEMA_PHONE,
    calls,
    "declined",
    [],
    [{ id: "d-2", label: "電話番号", text: "090-0000-0000" }],
  );
  const result = await resolver.resolve("example.com");
  assert.ok(result !== null, "resolve should return a result");
  assert.ok(!calls.includes("tier3-ticket"), "tier3Ticket must not be called on decline");
  assert.ok(!calls.includes("read-with-consent"), "readWithConsent must not be called on decline");
  assert.ok(result!.unresolved.some((u) => u.attributeKey === "phone.full"), "phone.full stays unresolved");
});

test("Tier 3 timeout → 0 tier3Ticket / readWithConsent API calls", async (t) => {
  const session = await t3Session(t);
  const calls: string[] = [];
  const resolver = t3Orchestrator(
    session,
    T3_SCHEMA_PHONE,
    calls,
    "timeout",
    [],
    [{ id: "d-2", label: "電話番号", text: "090-0000-0000" }],
  );
  const result = await resolver.resolve("example.com");
  assert.ok(result !== null, "resolve should return a result");
  assert.ok(!calls.includes("tier3-ticket"), "tier3Ticket must not be called on timeout");
  assert.ok(!calls.includes("read-with-consent"), "readWithConsent must not be called on timeout");
  assert.ok(result!.unresolved.some((u) => u.attributeKey === "phone.full"), "phone.full stays unresolved");
});

test("corroboration rejects fabricated value not present in item text", async (t) => {
  const session = await t3Session(t);
  const calls: string[] = [];
  // Cloud proposes a value that does not appear in the item text.
  const fabricatedValues = [{ itemId: "d-2", attributeKey: "phone.full", value: "099-9999-9999" }];
  const resolver = t3Orchestrator(
    session,
    T3_SCHEMA_PHONE,
    calls,
    "approved",
    fabricatedValues,
    [{ id: "d-2", label: "電話番号", text: "090-0000-0000" }],
  );
  const result = await resolver.resolve("example.com");
  assert.ok(calls.includes("tier3-ticket"), "tier3Ticket must be called on approval");
  assert.ok(calls.includes("read-with-consent"), "readWithConsent must be called on approval");
  // The fabricated value must not appear in the result.
  assert.ok(!result!.values.some((v) => v.value === "099-9999-9999"), "fabricated value must be rejected");
  assert.ok(result!.unresolved.some((u) => u.attributeKey === "phone.full"), "phone.full stays unresolved");
});

test("corroboration rejects value proposed for a different item (cross-item)", async (t) => {
  const session = await t3Session(t);
  const calls: string[] = [];
  // Cloud proposes a value using an itemId that is not in the payload.
  const crossItemValues = [{ itemId: "d-99", attributeKey: "phone.full", value: "090-0000-0000" }];
  const resolver = t3Orchestrator(
    session,
    T3_SCHEMA_PHONE,
    calls,
    "approved",
    crossItemValues,
    [{ id: "d-2", label: "電話番号", text: "090-0000-0000" }],
  );
  const result = await resolver.resolve("example.com");
  assert.ok(!result!.values.some((v) => v.attributeKey === "phone.full"), "cross-item value must be rejected");
  assert.ok(result!.unresolved.some((u) => u.attributeKey === "phone.full"), "phone.full stays unresolved");
});

const PHONE_REGION: MaskedRegionItem[] = [{ id: "d-2", label: "電話番号", text: "090-0000-0000" }];
const PHONE_VALUE = [{ itemId: "d-2", attributeKey: "phone.full", value: "090-0000-0000" }];

function callCount(calls: string[], name: string): number {
  return calls.filter((call) => call === name).length;
}

test("run approval is reused for the same site, page kind, and attributes", async (t) => {
  const session = await t3Session(t);
  const calls: string[] = [];
  const gates = { count: 0 };
  const resolver = t3Orchestrator(session, T3_SCHEMA_PHONE, calls, "run", PHONE_VALUE, PHONE_REGION, {
    purposeHints: ["contact"],
    gateCalls: gates,
  });
  const first = await resolver.resolve("example.com");
  const second = await resolver.resolve("example.com");
  assert.equal(gates.count, 1);
  assert.equal(callCount(calls, "tier3-ticket"), 2);
  assert.equal(callCount(calls, "read-with-consent"), 2);
  assert.ok(first?.values.some((value) => value.value === "090-0000-0000"));
  assert.ok(second?.values.some((value) => value.value === "090-0000-0000"));
});

test("a new page kind or attribute asks again and decline sends nothing more", async (t) => {
  const session = await t3Session(t);
  const calls: string[] = [];
  const gates = { count: 0 };
  const resolver = t3Orchestrator(session, T3_SCHEMA_PHONE, calls, ["run", "declined"], PHONE_VALUE, PHONE_REGION, {
    purposeHints: ["contact", "payment"],
    gateCalls: gates,
  });
  await resolver.resolve("example.com");
  await resolver.resolve("example.com");
  assert.equal(gates.count, 2);
  assert.equal(callCount(calls, "tier3-ticket"), 1);

  const expandedSchema = {
    ...T3_SCHEMA_PHONE,
    fields: [...T3_SCHEMA_PHONE.fields],
  };
  const expanded = ["phone.full"];
  const calls2: string[] = [];
  const gates2 = { count: 0 };
  const again = t3Orchestrator(session, expandedSchema, calls2, ["run", "declined"], PHONE_VALUE, PHONE_REGION, {
    purposeHints: ["contact"],
    unresolvedKeys: expanded,
    gateCalls: gates2,
  });
  await again.resolve("example.com");
  (
    expandedSchema.fields as { anchor: string; attributeKey: string; required: boolean }[]
  ).push({ anchor: "f-3", attributeKey: "name.full", required: true });
  expanded.push("name.full");
  await again.resolve("example.com");
  assert.equal(gates2.count, 2);
  assert.equal(callCount(calls2, "read-with-consent"), 1);
});

test("run approval stops at 20 requests and at 15 minutes", async (t) => {
  const session = await t3Session(t);
  const calls: string[] = [];
  const gates = { count: 0 };
  const resolver = t3Orchestrator(session, T3_SCHEMA_PHONE, calls, ["run", "declined"], PHONE_VALUE, PHONE_REGION, {
    purposeHints: ["contact"],
    gateCalls: gates,
  });
  for (let i = 0; i < 20; i++) await resolver.resolve("example.com");
  assert.equal(gates.count, 1);
  assert.equal(callCount(calls, "read-with-consent"), 20);
  await resolver.resolve("example.com");
  assert.equal(gates.count, 2);
  assert.equal(callCount(calls, "read-with-consent"), 20);

  let now = 1_000_000;
  const timedCalls: string[] = [];
  const timedGates = { count: 0 };
  const timed = t3Orchestrator(session, T3_SCHEMA_PHONE, timedCalls, ["run", "declined"], PHONE_VALUE, PHONE_REGION, {
    purposeHints: ["contact"],
    gateCalls: timedGates,
    now: () => now,
  });
  await timed.resolve("example.com");
  now += 15 * 60 * 1000;
  await timed.resolve("example.com");
  assert.equal(timedGates.count, 2);
  assert.equal(callCount(timedCalls, "tier3-ticket"), 1);
});

test("transport and 5xx retry once under run approval and consume a fresh ticket", async (t) => {
  const session = await t3Session(t);
  const calls: string[] = [];
  const resolver = t3Orchestrator(session, T3_SCHEMA_PHONE, calls, "run", PHONE_VALUE, PHONE_REGION, {
    purposeHints: ["contact"],
    statuses: [200, 500, 200, 200],
  });
  const result = await resolver.resolve("example.com");
  assert.equal(callCount(calls, "tier3-ticket"), 2);
  assert.equal(callCount(calls, "read-with-consent"), 2);
  assert.ok(result?.values.some((value) => value.value === "090-0000-0000"));

  const networkCalls: string[] = [];
  const network = t3Orchestrator(session, T3_SCHEMA_PHONE, networkCalls, "run", PHONE_VALUE, PHONE_REGION, {
    purposeHints: ["contact"],
    statuses: ["network", 200, 200],
  });
  await network.resolve("example.com");
  assert.equal(callCount(networkCalls, "tier3-ticket"), 2);
  assert.equal(callCount(networkCalls, "read-with-consent"), 1);
});

test("single approval does not retry, and 429, budget, and 4xx never retry", async (t) => {
  const session = await t3Session(t);
  const singleCalls: string[] = [];
  const single = t3Orchestrator(session, T3_SCHEMA_PHONE, singleCalls, "single", PHONE_VALUE, PHONE_REGION, {
    purposeHints: ["contact"],
    statuses: [200, 500],
  });
  await single.resolve("example.com");
  assert.equal(callCount(singleCalls, "tier3-ticket"), 1);
  assert.equal(callCount(singleCalls, "read-with-consent"), 1);

  for (const status of ["rate", "budget", 400] as const) {
    const calls: string[] = [];
    const resolver = t3Orchestrator(session, T3_SCHEMA_PHONE, calls, "run", PHONE_VALUE, PHONE_REGION, {
      purposeHints: ["contact"],
      statuses: status === 400 || status === "budget" ? [status] : [200, status],
    });
    await resolver.resolve("example.com");
    assert.equal(callCount(calls, "tier3-ticket"), 1, String(status));
    assert.equal(callCount(calls, "read-with-consent"), status === "rate" ? 1 : 0, String(status));
  }
});

test("run approval is refused when the page kind is unknown", async (t) => {
  const session = await t3Session(t);
  const calls: string[] = [];
  const resolver = t3Orchestrator(session, T3_SCHEMA_PHONE, calls, "run", PHONE_VALUE, PHONE_REGION, {
    purposeHints: ["unknown"],
  });
  const result = await resolver.resolve("example.com");
  assert.equal(callCount(calls, "tier3-ticket"), 0);
  assert.ok(result?.unresolved.some((item) => item.attributeKey === "phone.full"));
});

test("turning cloud assistance off during the gate sends nothing", async (t) => {
  const session = await t3Session(t);
  const calls: string[] = [];
  const resolver = t3Orchestrator(session, T3_SCHEMA_PHONE, calls, "run", PHONE_VALUE, PHONE_REGION, {
    purposeHints: ["contact"],
    onGate: () => {
      const current = session.vault.get("cloudSettings", "cloud");
      if (!current) return;
      session.vault.put("cloudSettings", { ...current, cloudAssistEnabled: false, updatedAt: current.updatedAt + 1 });
    },
  });
  await resolver.resolve("example.com");
  assert.equal(callCount(calls, "tier3-ticket"), 0);
  assert.equal(callCount(calls, "read-with-consent"), 0);
});

test("a response after revocation or navigation is not returned", async (t) => {
  const session = await t3Session(t);
  const calls: string[] = [];
  const hash = T3_SCHEMA_PHONE.pageFingerprints[0]!;
  let print = hash;
  let revoked: ResolutionOrchestrator | undefined;
  revoked = t3Orchestrator(session, T3_SCHEMA_PHONE, calls, "run", PHONE_VALUE, PHONE_REGION, {
    purposeHints: ["contact"],
    onRead: () => revoked?.revokeConsent(),
    fingerprint: () => print,
  });
  const revokedResult = await revoked.resolve("example.com");
  assert.ok(!revokedResult?.values.some((value) => value.attributeKey === "phone.full"));

  print = hash;
  const movedCalls: string[] = [];
  const moved = t3Orchestrator(session, T3_SCHEMA_PHONE, movedCalls, "single", PHONE_VALUE, PHONE_REGION, {
    purposeHints: ["contact"],
    fingerprint: () => print,
    onRead: () => {
      print = "e".repeat(64);
    },
  });
  const movedResult = await moved.resolve("example.com");
  assert.equal(callCount(movedCalls, "read-with-consent"), 1);
  assert.ok(!movedResult?.values.some((value) => value.value === "090-0000-0000"));
});

test("Tier 2 transport failure does not open Tier 3", async (t) => {
  const session = await t3Session(t);
  const calls: string[] = [];
  const hash = T3_SCHEMA_PHONE.pageFingerprints[0]!;
  const client = new CloudClient(
    { apiBaseUrl: "https://api.example/", fallbackBaseUrl: "https://fallback.example/" },
    async (url) => {
      const urlStr = String(url);
      if (urlStr.endsWith("/resolve")) {
        calls.push("resolve");
        return new Response(JSON.stringify({ status: "active", schema: T3_SCHEMA_PHONE }));
      }
      calls.push("map-structure");
      return new Response(JSON.stringify({ error: "unavailable" }), { status: 500 });
    },
  );
  const resolver = new ResolutionOrchestrator({
    session,
    client,
    clientVersion: "0.1.2",
    isActive: () => true,
    showConsentGate: () => {
      calls.push("gate");
      return Promise.resolve("run");
    },
    sendPageCommand: async (command) => {
      if (command.command === "schemaFingerprint") return hash;
      if (command.command === "structureSnapshot") {
        return {
          site: "example.com",
          pageFingerprint: hash,
          purposeHint: "contact" as const,
          items: [{ id: "f-2", tag: "input" as const, nameTokens: ["phone"] }],
        };
      }
      if (command.command === "readSchema") {
        return {
          values: [{ itemId: "f-1", attributeKey: "email" as const, value: "fake@example.com" }],
          unresolved: [{ attributeKey: "phone.full" as const, reason: "anchor-not-found" as const }],
        };
      }
      return null;
    },
  });
  await resolver.resolve("example.com");
  assert.equal(calls.includes("gate"), false);
  assert.equal(calls.includes("tier3-ticket"), false);
});

test("corroboration rejects masked PAN (card.number containing *)", async (t) => {
  const session = await t3Session(t);
  const calls: string[] = [];
  // Masked PAN passes buildTier3Payload but must be rejected by corroborateValue.
  const maskedPanValues = [{ itemId: "d-2", attributeKey: "card.number", value: "**** **** **** 1234" }];
  const resolver = t3Orchestrator(
    session,
    T3_SCHEMA_CARD,
    calls,
    "approved",
    maskedPanValues,
    [{ id: "d-2", label: "カード番号", text: "**** **** **** 1234" }],
  );
  const result = await resolver.resolve("example.com");
  assert.ok(!result!.values.some((v) => v.attributeKey === "card.number"), "masked PAN must be rejected");
  assert.ok(result!.unresolved.some((u) => u.attributeKey === "card.number"), "card.number stays unresolved");
});

// ---------------------------------------------------------------------------
// readRegionMasked delegation: secretCollectionItem masks secret field types
// readRegionMasked delegates C0 masking to secretCollectionItem (design #554 §5.3 / Issue #572).
// These tests verify that the underlying classifier correctly identifies secret fields.
// ---------------------------------------------------------------------------

function makeCollectionItem(type: string, autocomplete: string): CollectionItem {
  return {
    id: "f-1",
    value: "any-value",
    field: {
      fieldId: "f-1",
      tag: "input",
      type,
      name: "field1",
      id: "field1",
      autocomplete,
      required: false,
      placeholder: "",
      labels: [],
      nearbyText: "",
    },
  };
}

test("readRegionMasked delegation: type=password is masked via secretCollectionItem", () => {
  assert.ok(secretCollectionItem(makeCollectionItem("password", "")));
});

test("readRegionMasked delegation: autocomplete=current-password is masked via secretCollectionItem", () => {
  assert.ok(secretCollectionItem(makeCollectionItem("text", "current-password")));
});

test("readRegionMasked delegation: autocomplete=new-password is masked via secretCollectionItem", () => {
  assert.ok(secretCollectionItem(makeCollectionItem("text", "new-password")));
});

test("readRegionMasked delegation: autocomplete=one-time-code is masked via secretCollectionItem", () => {
  assert.ok(secretCollectionItem(makeCollectionItem("text", "one-time-code")));
});

test("readRegionMasked delegation: autocomplete=cc-csc is masked via secretCollectionItem", () => {
  assert.ok(secretCollectionItem(makeCollectionItem("text", "cc-csc")));
});

test("readRegionMasked delegation: non-secret type=text with autocomplete=email is not masked", () => {
  assert.ok(!secretCollectionItem(makeCollectionItem("text", "email")));
});
