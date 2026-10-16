import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { VaultSession } from "../../src/store/vault-session.js";
import { FileVaultPersistence } from "../../src/store/file-vault-persistence.js";
import type { CloudQueueItem, CloudSettings } from "../../src/domain/entities.js";
import {
  deliverQueue,
  computeNextAttemptAt,
  isDue,
  shouldDiscard,
  RETRY_BASE_MS,
  MAX_ATTEMPTS,
  MAX_AGE_MS,
  MAX_DELIVERY_BATCH,
  type DeliveryClient,
} from "../../extension/cloud-delivery-queue.js";
import { CloudClientError } from "../../extension/cloud-client.js";
import { validateCloudRequest } from "../../src/shared/cloud-contract.js";

// ── Pure function unit tests ──────────────────────────────────────────────────

test("computeNextAttemptAt: 30 s, 60 s, 120 s backoff schedule", () => {
  const now = 0;
  assert.equal(computeNextAttemptAt(1, now), RETRY_BASE_MS);
  assert.equal(computeNextAttemptAt(2, now), RETRY_BASE_MS * 2);
  assert.equal(computeNextAttemptAt(3, now), RETRY_BASE_MS * 4);
});

test("isDue: undefined nextAttemptAt means immediately due", () => {
  assert.equal(isDue(undefined, 0), true);
  assert.equal(isDue(0, 0), true);
  assert.equal(isDue(1000, 999), false);
  assert.equal(isDue(1000, 1000), true);
  assert.equal(isDue(1000, 1001), true);
});

test("shouldDiscard: MAX_ATTEMPTS threshold", () => {
  const now = 0;
  assert.equal(shouldDiscard("cloud-unreachable", MAX_ATTEMPTS - 1, 0, now), false);
  assert.equal(shouldDiscard("cloud-unreachable", MAX_ATTEMPTS, 0, now), true);
});

test("shouldDiscard: MAX_AGE_MS threshold", () => {
  // enqueuedAt=0, now=MAX_AGE_MS+1 → age=MAX_AGE_MS+1 > MAX_AGE_MS → discard
  assert.equal(shouldDiscard("", 0, 0, MAX_AGE_MS + 1), true);
  // enqueuedAt=0, now=MAX_AGE_MS → age=MAX_AGE_MS, not strictly > → keep
  assert.equal(shouldDiscard("", 0, 0, MAX_AGE_MS), false);
  // Very fresh item (enqueuedAt close to now) → keep
  assert.equal(shouldDiscard("", 0, MAX_AGE_MS - 1, MAX_AGE_MS), false);
});

test("shouldDiscard: budget-exhausted and ai-invalid-response are non-retryable", () => {
  assert.equal(shouldDiscard("budget-exhausted", 0, 0, 0), true);
  assert.equal(shouldDiscard("ai-invalid-response", 0, 0, 0), true);
  assert.equal(shouldDiscard("cloud-unreachable", 0, 0, 0), false);
  assert.equal(shouldDiscard("server-error", 0, 0, 0), false);
  assert.equal(shouldDiscard("rate-limited", 0, 0, 0), false);
  assert.equal(shouldDiscard("client-error", 0, 0, 0), true);
});

// ── Session fixture ───────────────────────────────────────────────────────────

async function makeSession(t: test.TestContext) {
  const dir = await mkdtemp(join(tmpdir(), "delivery-"));
  const path = join(dir, "vault.json");
  const session = new VaultSession({
    persistence: new FileVaultPersistence(path),
    kdfAlgo: "pbkdf2-sha512",
    lockManager: { tryAcquire: async () => ({ release() {} }) },
  });
  await session.start();
  await session.create("fake-test-passphrase-long");
  t.after(async () => {
    session.close();
    await rm(dir, { recursive: true, force: true });
  });
  return session;
}

function initQueue(session: VaultSession, items: CloudQueueItem[] = []) {
  session.vault.put("cloudSettings", {
    id: "cloud",
    cloudAssistEnabled: true,
    telemetryEnabled: true,
    validatorKey: "fake-local-validator-key",
    queue: items,
    updatedAt: 0,
  } satisfies CloudSettings);
}

function feedbackItem(overrides: Partial<CloudQueueItem> = {}): CloudQueueItem {
  const hash = "a".repeat(64);
  const uuid = "11111111-1111-4111-8111-111111111111";
  return {
    idempotencyKey: uuid,
    kind: "feedback",
    body: {
      schemaId: null,
      site: "example.com",
      pageFingerprint: hash,
      pagePurpose: "contact",
      mappings: [{ anchor: "f-1", attributeKey: "email" }],
      outcome: "validated",
      resolutionTier: "gemini_structure",
      siteValidatorToken: "b".repeat(64),
      idempotencyKey: uuid,
    },
    attempts: 0,
    enqueuedAt: Date.now(),
    ...overrides,
  };
}

// Delivery client stubs

function alwaysSucceed(): DeliveryClient {
  return { call: async () => ({ accepted: true }) as never };
}

function alwaysFail(category: CloudClientError["category"]): DeliveryClient {
  return {
    call: async () => {
      throw new CloudClientError(category);
    },
  };
}

// ── deliverQueue integration tests ────────────────────────────────────────────

test("successful delivery removes item from queue", async (t) => {
  const session = await makeSession(t);
  const item = feedbackItem();
  initQueue(session, [item]);
  await deliverQueue(session, alwaysSucceed());
  assert.equal(session.vault.get("cloudSettings", "cloud")!.queue.length, 0);
});

test("cloud-unreachable increments attempts and sets nextAttemptAt", async (t) => {
  const session = await makeSession(t);
  const now = Date.now();
  const item = feedbackItem({ enqueuedAt: now });
  initQueue(session, [item]);
  await deliverQueue(session, alwaysFail("cloud-unreachable"));
  const queue = session.vault.get("cloudSettings", "cloud")!.queue;
  assert.equal(queue.length, 1);
  assert.equal(queue[0]!.attempts, 1);
  assert.ok(queue[0]!.nextAttemptAt! >= now + RETRY_BASE_MS - 100);
});

test("rate-limited increments attempts and sets nextAttemptAt", async (t) => {
  const session = await makeSession(t);
  const item = feedbackItem();
  initQueue(session, [item]);
  await deliverQueue(session, alwaysFail("rate-limited"));
  const queue = session.vault.get("cloudSettings", "cloud")!.queue;
  assert.equal(queue.length, 1);
  assert.equal(queue[0]!.attempts, 1);
});

test("budget-exhausted discards item immediately (no retry)", async (t) => {
  const session = await makeSession(t);
  initQueue(session, [feedbackItem()]);
  await deliverQueue(session, alwaysFail("budget-exhausted"));
  assert.equal(session.vault.get("cloudSettings", "cloud")!.queue.length, 0);
});

test("ai-invalid-response discards item immediately (no retry)", async (t) => {
  const session = await makeSession(t);
  initQueue(session, [feedbackItem()]);
  await deliverQueue(session, alwaysFail("ai-invalid-response"));
  assert.equal(session.vault.get("cloudSettings", "cloud")!.queue.length, 0);
});

test(`items are discarded after ${MAX_ATTEMPTS} failures`, async (t) => {
  const session = await makeSession(t);
  // Start with attempts already at MAX_ATTEMPTS (all retries exhausted).
  initQueue(session, [feedbackItem({ attempts: MAX_ATTEMPTS })]);
  // The item is due (no nextAttemptAt) but should be discarded before attempting delivery.
  await deliverQueue(session, alwaysSucceed());
  assert.equal(session.vault.get("cloudSettings", "cloud")!.queue.length, 0);
});

test("items older than MAX_AGE_MS are discarded without delivery", async (t) => {
  const session = await makeSession(t);
  const stale = feedbackItem({ enqueuedAt: Date.now() - MAX_AGE_MS - 1 });
  initQueue(session, [stale]);
  let called = false;
  const client: DeliveryClient = {
    call: async () => {
      called = true;
      return { accepted: true } as never;
    },
  };
  await deliverQueue(session, client);
  assert.equal(session.vault.get("cloudSettings", "cloud")!.queue.length, 0);
  assert.equal(called, false);
});

test("idempotencyKey is preserved across retries (never regenerated)", async (t) => {
  const session = await makeSession(t);
  const uuid = "22222222-2222-4222-8222-222222222222";
  const hash = "a".repeat(64);
  const item = feedbackItem({ idempotencyKey: uuid, attempts: 0 });
  // Align the body idempotencyKey too
  (item.body as Record<string, unknown>).idempotencyKey = uuid;
  initQueue(session, [item]);
  await deliverQueue(session, alwaysFail("cloud-unreachable"));
  const queue = session.vault.get("cloudSettings", "cloud")!.queue;
  assert.equal(queue[0]!.idempotencyKey, uuid);
});

test("items not yet due (nextAttemptAt in future) are skipped", async (t) => {
  const session = await makeSession(t);
  const future = Date.now() + 60_000;
  const item = feedbackItem({ nextAttemptAt: future });
  initQueue(session, [item]);
  let called = false;
  const client: DeliveryClient = {
    call: async () => {
      called = true;
      return { accepted: true } as never;
    },
  };
  await deliverQueue(session, client);
  // Item is still in queue, unmodified
  assert.equal(session.vault.get("cloudSettings", "cloud")!.queue.length, 1);
  assert.equal(called, false);
});

test("cloudAssistEnabled: false prevents delivery", async (t) => {
  const session = await makeSession(t);
  session.vault.put("cloudSettings", {
    id: "cloud",
    cloudAssistEnabled: false,
    telemetryEnabled: true,
    validatorKey: "fake-key",
    queue: [feedbackItem()],
    updatedAt: 0,
  });
  let called = false;
  const client: DeliveryClient = {
    call: async () => {
      called = true;
      return { accepted: true } as never;
    },
  };
  await deliverQueue(session, client);
  assert.equal(session.vault.get("cloudSettings", "cloud")!.queue.length, 1);
  assert.equal(called, false);
});

test("telemetryEnabled: false prevents delivery even when cloudAssistEnabled is true", async (t) => {
  const session = await makeSession(t);
  session.vault.put("cloudSettings", {
    id: "cloud",
    cloudAssistEnabled: true,
    telemetryEnabled: false,
    validatorKey: "fake-key",
    queue: [feedbackItem()],
    updatedAt: 0,
  });
  let called = false;
  const client: DeliveryClient = {
    call: async () => {
      called = true;
      return { accepted: true } as never;
    },
  };
  await deliverQueue(session, client);
  assert.equal(session.vault.get("cloudSettings", "cloud")!.queue.length, 1);
  assert.equal(called, false);
});

test(`MAX_DELIVERY_BATCH (${MAX_DELIVERY_BATCH}) caps items processed per pass`, async (t) => {
  const session = await makeSession(t);
  const items: CloudQueueItem[] = Array.from({ length: MAX_DELIVERY_BATCH + 5 }, (_, i) => {
    const uuid = `${String(i).padStart(8, "0")}-1111-4111-8111-111111111111`;
    const item = feedbackItem({ idempotencyKey: uuid, attempts: 0 });
    (item.body as Record<string, unknown>).idempotencyKey = uuid;
    return item;
  });
  initQueue(session, items);
  let calls = 0;
  const client: DeliveryClient = {
    call: async () => {
      calls++;
      return { accepted: true } as never;
    },
  };
  await deliverQueue(session, client);
  assert.equal(calls, MAX_DELIVERY_BATCH);
  assert.equal(session.vault.get("cloudSettings", "cloud")!.queue.length, 5);
});

test("concurrent enqueue is not lost when delivery removes a different item", async (t) => {
  const session = await makeSession(t);
  const uuid1 = "11111111-1111-4111-8111-111111111111";
  const uuid2 = "22222222-2222-4222-8222-222222222222";
  const item1 = feedbackItem({ idempotencyKey: uuid1 });
  (item1.body as Record<string, unknown>).idempotencyKey = uuid1;
  initQueue(session, [item1]);

  // Simulate a concurrent enqueue during delivery by adding item2 inside the client call.
  const client: DeliveryClient = {
    call: async () => {
      // Concurrent enqueue while item1 delivery is in-flight.
      const current = session.vault.get("cloudSettings", "cloud")!;
      const item2 = feedbackItem({ idempotencyKey: uuid2 });
      (item2.body as Record<string, unknown>).idempotencyKey = uuid2;
      session.vault.put("cloudSettings", {
        ...current,
        queue: [...current.queue, item2],
        updatedAt: Date.now(),
      });
      return { accepted: true } as never;
    },
  };

  await deliverQueue(session, client);
  const queue = session.vault.get("cloudSettings", "cloud")!.queue;
  // item1 removed, item2 preserved
  assert.equal(queue.length, 1);
  assert.equal(queue[0]!.idempotencyKey, uuid2);
});

test("locked session is a no-op", async (t) => {
  const session = await makeSession(t);
  initQueue(session, [feedbackItem()]);
  session.lock();
  let called = false;
  const client: DeliveryClient = {
    call: async () => {
      called = true;
      return { accepted: true } as never;
    },
  };
  await deliverQueue(session, client);
  assert.equal(called, false);
});

test("feedback body is validated before delivery; contract failures discard the item", async (t) => {
  const session = await makeSession(t);
  // Corrupt body that fails validateCloudRequest("feedback", ...)
  const corrupt = feedbackItem();
  (corrupt.body as Record<string, unknown>).site = "not-a-valid-site!!!";
  initQueue(session, [corrupt]);
  let called = false;
  const client: DeliveryClient = {
    call: async () => {
      called = true;
      return { accepted: true } as never;
    },
  };
  await deliverQueue(session, client);
  // Discarded without calling client
  assert.equal(session.vault.get("cloudSettings", "cloud")!.queue.length, 0);
  assert.equal(called, false);
});
