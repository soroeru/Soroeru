/**
 * Host-level wiring test for queue delivery (Issue #567 fix-cycle 1).
 *
 * Proves that `VisibilityHost`, when constructed with a `deliveryClient`, drains
 * the vault's pending queue when the session transitions to "unlocked". This
 * verifies the end-to-end wiring without the Chrome extension environment.
 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { VaultSession } from "../../src/store/vault-session.js";
import { FileVaultPersistence } from "../../src/store/file-vault-persistence.js";
import type { CloudSettings } from "../../src/domain/entities.js";
import { VisibilityHost } from "../../extension/panel/visibility-host.js";
import type { LeaseClient } from "../../extension/panel/lease-client.js";
import type { DeliveryClient } from "../../extension/cloud-delivery-queue.js";

const PASSPHRASE = "visibility-host-delivery-passphrase";
const FEEDBACK_UUID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const PAGE_FINGERPRINT = "a".repeat(64);

/** Minimal stub for LeaseClient that satisfies VisibilityHost without Chrome. */
function makeStubLeaseClient(): LeaseClient {
  return {
    onInvalidated: () => () => {},
    sendPageCommand: () => Promise.reject(new Error("not implemented in stub")),
    isLeaseActive: () => false,
    releaseLease: async () => {},
    close: () => {},
  } as unknown as LeaseClient;
}

test("VisibilityHost: queued feedback item is delivered when the session unlocks", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "vh-delivery-"));
  t.after(() => rm(dir, { recursive: true, force: true }));

  const session = new VaultSession({
    persistence: new FileVaultPersistence(join(dir, "vault.json")),
    kdfAlgo: "pbkdf2-sha512",
    lockManager: { tryAcquire: async () => ({ release() {} }) },
  });
  await session.start();
  await session.create(PASSPHRASE);

  // Write a queued feedback item to the unlocked vault.
  session.vault.put("cloudSettings", {
    id: "cloud",
    cloudAssistEnabled: true,
    telemetryEnabled: true,
    validatorKey: "fake-validator-key",
    queue: [
      {
        idempotencyKey: FEEDBACK_UUID,
        kind: "feedback",
        body: {
          schemaId: null,
          site: "example.com",
          pageFingerprint: PAGE_FINGERPRINT,
          pagePurpose: "contact",
          mappings: [{ anchor: "f-1", attributeKey: "email" }],
          outcome: "validated",
          resolutionTier: "gemini_structure",
          siteValidatorToken: "b".repeat(64),
          idempotencyKey: FEEDBACK_UUID,
        },
        attempts: 0,
        enqueuedAt: Date.now(),
      },
    ],
    updatedAt: Date.now(),
  } satisfies CloudSettings);
  await session.save();

  // Lock the session before constructing the host, so the unlock event is observable.
  session.lock();

  const deliveredKeys: string[] = [];
  const deliveryClient: DeliveryClient = {
    call: async (_op, req) => {
      deliveredKeys.push((req as { idempotencyKey: string }).idempotencyKey);
      return { accepted: true } as never;
    },
  };

  const host = new VisibilityHost({
    session,
    leaseClient: makeStubLeaseClient(),
    deliveryClient,
  });

  // Unlock triggers onSessionState("unlocked") which fires delivery.
  await session.unlock(PASSPHRASE);

  // Wait for the fire-and-forget delivery to complete (condition-based).
  const deadline = Date.now() + 2000;
  while (deliveredKeys.length === 0 && Date.now() < deadline) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }

  assert.equal(deliveredKeys.length, 1, "delivery client should be called once");
  assert.equal(deliveredKeys[0], FEEDBACK_UUID, "delivery uses the correct idempotencyKey");

  await host.shutdown();
});

test("VisibilityHost: delivery is skipped when no deliveryClient is configured", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "vh-no-delivery-"));
  t.after(() => rm(dir, { recursive: true, force: true }));

  const session = new VaultSession({
    persistence: new FileVaultPersistence(join(dir, "vault.json")),
    kdfAlgo: "pbkdf2-sha512",
    lockManager: { tryAcquire: async () => ({ release() {} }) },
  });
  await session.start();
  await session.create(PASSPHRASE);

  session.vault.put("cloudSettings", {
    id: "cloud",
    cloudAssistEnabled: true,
    telemetryEnabled: true,
    validatorKey: "fake-validator-key",
    queue: [
      {
        idempotencyKey: FEEDBACK_UUID,
        kind: "feedback",
        body: {
          schemaId: null,
          site: "example.com",
          pageFingerprint: PAGE_FINGERPRINT,
          pagePurpose: "contact",
          mappings: [{ anchor: "f-1", attributeKey: "email" }],
          outcome: "validated",
          resolutionTier: "gemini_structure",
          siteValidatorToken: "b".repeat(64),
          idempotencyKey: FEEDBACK_UUID,
        },
        attempts: 0,
        enqueuedAt: Date.now(),
      },
    ],
    updatedAt: Date.now(),
  } satisfies CloudSettings);
  await session.save();
  session.lock();

  // No deliveryClient passed.
  const host = new VisibilityHost({
    session,
    leaseClient: makeStubLeaseClient(),
  });

  await session.unlock(PASSPHRASE);
  // Give the event loop a few turns.
  for (let i = 0; i < 5; i++) await new Promise<void>((resolve) => setImmediate(resolve));

  const remaining = session.vault.get("cloudSettings", "cloud")!.queue;
  assert.equal(remaining.length, 1, "queue should be untouched when no deliveryClient");

  await host.shutdown();
});
