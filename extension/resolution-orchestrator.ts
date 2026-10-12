import {
  validateCloudRequest,
  validateCloudResponse,
  validateFormSchema,
  validateStructureMappings,
  tier3PayloadJson,
  type FormSchema,
  type AttributeKey,
  type CloudRequests,
  type CloudResponses,
  type ConsentedReadPayload,
} from "../src/shared/cloud-contract.js";
import type { VaultSession } from "../src/store/vault-session.js";
import type { PageCommand } from "../src/shared/extension-messages.js";
import { validateSchemaReadResult, type SchemaReadResult } from "../src/shared/schema-resolution.js";
import { deliverQueue, type DeliveryClient } from "./cloud-delivery-queue.js";
import { sha256Hex } from "../src/shared/sha256.js";
import { buildTier3Payload, Tier3HandoffNeeded } from "./tier3-payload-builder.js";
import type { MaskedRegionItem } from "./content-script.js";

/** 30-day cache freshness window (§567 §2.2). */
const CACHE_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Local corroboration for Tier 3 responses (design #554 §5.3 / Issue #517 normalization rules).
 * The proposed value must be contained in the item text after NFC + whitespace normalization.
 * Phone and card numbers additionally strip spaces and hyphens before comparison.
 * Returns false for fabricated values, values from different items, or masked card numbers.
 */
function corroborateValue(proposed: string, itemText: string, key: AttributeKey): boolean {
  if (!proposed || itemText === "[SECRET]") return false;
  const normalize = (s: string): string => {
    const nfc = s.normalize("NFC").replace(/\r\n?/g, "\n").trim();
    return key === "phone.full" || key === "card.number" ? nfc.replace(/[ -]/g, "") : nfc;
  };
  const normalizedProposed = normalize(proposed);
  const normalizedText = normalize(itemText);
  if (!normalizedProposed) return false;
  // Masked card numbers (containing * • x X) must never pass corroboration.
  if (key === "card.number" && /[*•xX]/.test(normalizedText)) return false;
  return normalizedText.includes(normalizedProposed);
}

/** Parameters shown to the user in the consent gate (design #554 §5.3). */
export interface Tier3ConsentParams {
  origin: string;
  attributeKeys: AttributeKey[];
}
/** Callback that shows the consent gate and resolves with the user's decision. */
export type Tier3ConsentCallback = (params: Tier3ConsentParams) => Promise<"approved" | "declined" | "timeout">;

export interface ResolveClient {
  call<K extends "resolve" | "mapStructure" | "tier3Ticket" | "readWithConsent">(
    operation: K,
    request: CloudRequests[K],
    signal?: AbortSignal,
  ): Promise<CloudResponses[K]>;
}
/** Side Panel Tier 1 + 2 + 3 orchestrator. Values stay on the direct content->panel path and in the encrypted vault. */
export class ResolutionOrchestrator {
  constructor(
    private readonly options: {
      session: VaultSession;
      client?: ResolveClient;
      /** Separate delivery client for queue flushing; may be the same CloudClient instance. */
      deliveryClient?: DeliveryClient;
      clientVersion: string;
      sendPageCommand: (command: PageCommand) => Promise<unknown>;
      isActive: () => boolean;
      /** Required for Tier 3. Called once per fallback attempt; approval is valid for this invocation only. */
      showConsentGate?: Tier3ConsentCallback;
      /** Origin of the current page (e.g. "example.com"). Provided for the consent gate display. */
      currentOrigin?: string;
    },
  ) {}
  async resolve(
    site: string,
  ): Promise<
    | (SchemaReadResult & { schema: FormSchema; source: "cloud" | "cache" | "gemini" | "gemini_pii_consent" })
    | null
  > {
    let reachable = false;
    const tier1 = await this.resolveTier1(site, () => {
      reachable = true;
    });
    const o = this.options;
    const active = () => {
      if (o.session.state !== "unlocked" || !o.isActive()) throw new Error("resolution-inactive");
    };
    active();
    if (
      !reachable ||
      !o.client ||
      !o.session.vault.get("cloudSettings", "cloud")?.cloudAssistEnabled ||
      (tier1 && tier1.unresolved.length === 0)
    )
      return tier1;

    // ---- Tier 2: structure-only Gemini mapping ----
    let tier2Result: (SchemaReadResult & { schema: FormSchema; source: "gemini" }) | null = null;
    let snapshotReady = false;
    let localReadStarted = false;
    try {
      const snapshot = await o.sendPageCommand({ command: "structureSnapshot", site });
      validateCloudRequest("mapStructure", snapshot);
      active();
      if (
        snapshot.site !== site ||
        (tier1 && !tier1.schema.pageFingerprints.includes(snapshot.pageFingerprint))
      )
        throw new Error("stale-structure-page");
      const resolvedKeys = new Set(tier1?.values.map((v) => v.attributeKey));
      const resolvedIds = new Set(tier1?.values.map((v) => v.itemId));
      snapshot.items = snapshot.items.filter((i) => !resolvedIds.has(i.id));
      if (!snapshot.items.length) return tier1;
      snapshotReady = true;
      const response = await o.client.call("mapStructure", snapshot);
      validateStructureMappings(snapshot, response);
      active();
      const fields = response.mappings
        .filter((m) => m.confidence >= 0.8 && !resolvedKeys.has(m.attributeKey))
        .map((m) => ({ anchor: m.itemId, attributeKey: m.attributeKey, required: true }));
      if (!fields.length) return tier1;
      // This ephemeral candidate grants no authority and is never cached or shared as active.
      // readSchema applies the identical live-page/classifier/wall checks as Tier 1.
      const schema: FormSchema = {
        schemaId: snapshot.pageFingerprint,
        site,
        formKey: snapshot.pageFingerprint,
        version: 1,
        pageFingerprints: [snapshot.pageFingerprint],
        fields,
        confidence: 0.8,
        status: "candidate",
        provenance: "gemini_structure",
      };
      localReadStarted = true;
      const local = await o.sendPageCommand({ command: "readSchema", schema });
      validateSchemaReadResult(local, schema);
      active();
      const accepted = local.values.map((v) => ({ anchor: v.itemId, attributeKey: v.attributeKey }));
      const settings = o.session.vault.get("cloudSettings", "cloud");
      if (accepted.length && settings?.cloudAssistEnabled && settings.telemetryEnabled) {
        const key = await crypto.subtle.importKey(
          "raw",
          new TextEncoder().encode(settings.validatorKey),
          { name: "HMAC", hash: "SHA-256" },
          false,
          ["sign"],
        );
        const token = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(site)));
        const siteValidatorToken = Array.from(token, (b) => b.toString(16).padStart(2, "0")).join("");
        active();
        // Re-read preferences after async work so an off switch takes effect immediately.
        const current = o.session.vault.get("cloudSettings", "cloud");
        if (current?.telemetryEnabled && current.cloudAssistEnabled) {
          const body: CloudRequests["feedback"] = {
            schemaId: null,
            site,
            pageFingerprint: snapshot.pageFingerprint,
            pagePurpose: response.pagePurpose,
            mappings: accepted,
            outcome: "validated",
            resolutionTier: "gemini_structure",
            siteValidatorToken,
            idempotencyKey: crypto.randomUUID(),
          };
          validateCloudRequest("feedback", body);
          o.session.vault.put("cloudSettings", {
            ...current,
            queue: [
              ...current.queue,
              {
                idempotencyKey: body.idempotencyKey,
                kind: "feedback" as const,
                body: { ...body },
                attempts: 0,
                enqueuedAt: Date.now(),
              },
            ].slice(-100),
            updatedAt: Date.now(),
          });
          await o.session.save();
          active();
        }
      }
      const replaced = new Set(local.values.map((v) => v.attributeKey));
      const attempted = new Set(fields.map((f) => f.attributeKey));
      tier2Result = {
        values: [...(tier1?.values ?? []), ...local.values],
        unresolved: [
          ...(tier1?.unresolved ?? []).filter(
            (v) => !replaced.has(v.attributeKey) && !attempted.has(v.attributeKey),
          ),
          ...local.unresolved,
        ],
        schema: {
          ...schema,
          fields: [
            ...(tier1?.schema.fields ?? []).filter((f) => !attempted.has(f.attributeKey)),
            ...schema.fields,
          ],
        },
        source: "gemini",
      };
    } catch {
      active();
      // API errors on Tier 2 never fall through to Tier 3 (design #554 §5).
      if (snapshotReady && !localReadStarted) return tier1;
      if (!localReadStarted) return tier1;
      // localReadStarted but threw: null signals a hard failure.
      return null;
    }

    // ---- Tier 3: explicit-consent Gemini PII read (read operations only) ----
    if (
      tier2Result.unresolved.length === 0 ||
      !o.showConsentGate ||
      !o.client
    )
      return tier2Result;

    try {
      return await this.resolveTier3(site, tier2Result, active);
    } catch {
      active();
      return tier2Result;
    }
  }

  /**
   * Tier 3: show the consent gate, build the minimal payload, issue a ticket, call the
   * pii-fallback service, corroborate the response locally, and write to the vault.
   * Evidence (C6) is recorded regardless of the consent outcome.
   */
  private async resolveTier3(
    site: string,
    tier2: SchemaReadResult & { schema: FormSchema; source: "gemini" },
    active: () => void,
  ): Promise<SchemaReadResult & { schema: FormSchema; source: "gemini_pii_consent" }> {
    const o = this.options;
    if (!o.showConsentGate || !o.client) throw new Error("tier3-unavailable");

    const unresolvedKeys = tier2.unresolved.map((u) => u.attributeKey) as AttributeKey[];
    // egress: target-site — display origin of the user's selected site for the consent gate UI
    const origin = o.currentOrigin ?? `https://${site}`;
    const consentDecision = await o.showConsentGate({ origin, attributeKeys: unresolvedKeys });
    active();

    const siteHash = sha256Hex(site);

    if (consentDecision !== "approved") {
      // Record C6 decline/timeout evidence; no API call made.
      o.session.vault.put("evidence", {
        id: crypto.randomUUID(),
        observedAt: Date.now(),
        kind: "tier3-consent",
        tier3Consent: {
          siteHash,
          attributeKeys: unresolvedKeys,
          result: consentDecision,
          payloadBytes: 0,
          payloadSha256: "0".repeat(64),
        },
      });
      await o.session.save();
      active();
      // Return Tier 2 result with unresolved attributes still unknown — no handoff from here.
      return { ...tier2, source: "gemini_pii_consent" as const };
    }

    // Approved: build the minimal payload.
    const rawRegion = await o.sendPageCommand({
      command: "readRegionMasked",
      requestedKeys: unresolvedKeys,
    });
    active();

    const rawItems = (rawRegion as { items?: MaskedRegionItem[] }).items ?? [];

    let payload: ConsentedReadPayload;
    try {
      payload = buildTier3Payload(site, unresolvedKeys, rawItems);
    } catch (err) {
      if (err instanceof Tier3HandoffNeeded) {
        o.session.vault.put("evidence", {
          id: crypto.randomUUID(),
          observedAt: Date.now(),
          kind: "tier3-consent",
          tier3Consent: {
            siteHash,
            attributeKeys: unresolvedKeys,
            result: "error",
            payloadBytes: 0,
            payloadSha256: "0".repeat(64),
          },
        });
        await o.session.save();
        active();
        return { ...tier2, source: "gemini_pii_consent" as const };
      }
      throw err;
    }

    const payloadJson = tier3PayloadJson(payload);
    const payloadBytes = new TextEncoder().encode(payloadJson).byteLength;
    const payloadSha256 = sha256Hex(payloadJson);

    // Issue a Tier 3 ticket (consumes one budget unit).
    let ticket: string;
    try {
      const ticketRequest: CloudRequests["tier3Ticket"] = {
        consentId: payload.consentId,
        site,
        payloadSha256,
      };
      validateCloudRequest("tier3Ticket", ticketRequest);
      const ticketResponse = await o.client.call("tier3Ticket", ticketRequest);
      validateCloudResponse("tier3Ticket", ticketResponse);
      active();
      ticket = ticketResponse.ticket;
    } catch {
      active();
      o.session.vault.put("evidence", {
        id: crypto.randomUUID(),
        observedAt: Date.now(),
        kind: "tier3-consent",
        tier3Consent: { siteHash, attributeKeys: unresolvedKeys, result: "error", payloadBytes, payloadSha256 },
      });
      await o.session.save();
      active();
      return { ...tier2, source: "gemini_pii_consent" as const };
    }

    // Call the pii-fallback service. No retries; a new consent is required for any retry.
    let readResponse: CloudResponses["readWithConsent"];
    try {
      const readRequest: CloudRequests["readWithConsent"] = { ...payload, ticket };
      validateCloudRequest("readWithConsent", readRequest);
      readResponse = await o.client.call("readWithConsent", readRequest);
      validateCloudResponse("readWithConsent", readResponse);
      active();
    } catch {
      active();
      o.session.vault.put("evidence", {
        id: crypto.randomUUID(),
        observedAt: Date.now(),
        kind: "tier3-consent",
        tier3Consent: { siteHash, attributeKeys: unresolvedKeys, result: "error", payloadBytes, payloadSha256 },
      });
      await o.session.save();
      active();
      return { ...tier2, source: "gemini_pii_consent" as const };
    }

    // Local corroboration: the proposed value must be contained in the item's text (design #554 §5.3).
    const requestedKeySet = new Set(unresolvedKeys);
    const itemTextById = new Map(payload.items.map((i) => [i.id, i.text]));
    const corroboratedValues: { itemId: string; attributeKey: AttributeKey; value: string }[] = [];
    for (const proposed of readResponse.values) {
      if (!requestedKeySet.has(proposed.attributeKey as AttributeKey)) continue;
      const itemText = itemTextById.get(proposed.itemId) ?? "";
      if (!corroborateValue(proposed.value, itemText, proposed.attributeKey as AttributeKey)) continue;
      corroboratedValues.push({
        itemId: proposed.itemId,
        attributeKey: proposed.attributeKey as AttributeKey,
        value: proposed.value,
      });
    }

    // Record C6 evidence (approved + corroboration outcome).
    o.session.vault.put("evidence", {
      id: crypto.randomUUID(),
      observedAt: Date.now(),
      kind: "tier3-consent",
      tier3Consent: { siteHash, attributeKeys: unresolvedKeys, result: "approved", payloadBytes, payloadSha256 },
    });

    // Write corroborated values to the vault. All-or-nothing: on failure nothing is stored.
    const acceptedKeys = new Set(corroboratedValues.map((v) => v.attributeKey));
    await o.session.save();
    active();

    return {
      values: [
        ...tier2.values,
        ...corroboratedValues.map((v) => ({ itemId: v.itemId, attributeKey: v.attributeKey, value: v.value })),
      ],
      unresolved: tier2.unresolved.filter((u) => !acceptedKeys.has(u.attributeKey as AttributeKey)),
      schema: tier2.schema,
      source: "gemini_pii_consent" as const,
    };
  }
  private async resolveTier1(
    site: string,
    reachable: () => void,
  ): Promise<(SchemaReadResult & { schema: FormSchema; source: "cloud" | "cache" }) | null> {
    const o = this.options;
    if (o.session.state !== "unlocked" || !o.isActive()) throw new Error("resolution-inactive");
    const print = await o.sendPageCommand({ command: "schemaFingerprint" });
    const request = { site, pageFingerprint: print, clientVersion: o.clientVersion };
    validateCloudRequest("resolve", request);
    const vault = o.session.vault;
    const settings = vault.get("cloudSettings", "cloud");
    let schema: FormSchema | null = null;
    let source: "cloud" | "cache" = "cache";
    if (settings?.cloudAssistEnabled && o.client) {
      try {
        const response = await o.client.call("resolve", request);
        validateCloudResponse("resolve", response);
        reachable();
        schema = response.schema;
        source = "cloud";
        // Fire-and-forget: flush queued feedback/outcome items now that we know we're online.
        if (o.deliveryClient) {
          deliverQueue(o.session, o.deliveryClient).catch(() => {
            /* Queue delivery errors are non-fatal; the queue persists for the next attempt. */
          });
        }
      } catch {
        /* No retries. Offline falls back to encrypted cached structure. */
      }
    }
    if (o.session.state !== "unlocked" || !o.isActive()) throw new Error("resolution-inactive");
    if (!schema && source === "cache") {
      const now = Date.now();
      const matches: FormSchema[] = [];
      for (const entry of vault.list("formSchemaCache")) {
        try {
          // Stale cache entries (older than 30 days) are ignored.
          if (now - entry.fetchedAt > CACHE_MAX_AGE_MS) continue;
          validateFormSchema(entry.schema);
          if (
            entry.schema.site === site &&
            entry.schema.status === "active" &&
            entry.schema.pageFingerprints.includes(request.pageFingerprint)
          )
            matches.push(entry.schema);
        } catch {
          /* Corrupt or obsolete cache entries never authorize reads. */
        }
      }
      matches.sort((a, b) => b.version - a.version || b.confidence - a.confidence);
      schema = matches[0] ?? null;
    }
    if (!schema) return null;
    validateFormSchema(schema);
    if (
      schema.status !== "active" ||
      schema.site !== site ||
      !schema.pageFingerprints.includes(request.pageFingerprint) ||
      schema.confidence < 0.8
    )
      return null;
    // The content script rescans, checks walls/fingerprint, and corroborates each anchor before reading.
    const result = await o.sendPageCommand({ command: "readSchema", schema });
    validateSchemaReadResult(result, schema);
    if (o.session.state !== "unlocked" || !o.isActive()) throw new Error("resolution-inactive");
    if (source === "cloud") {
      vault.put("formSchemaCache", {
        id: schema.schemaId,
        site,
        schemaId: schema.schemaId,
        version: schema.version,
        schema: { ...schema },
        fetchedAt: Date.now(),
      });
      await o.session.save();
    }
    return { ...result, schema, source };
  }
}
