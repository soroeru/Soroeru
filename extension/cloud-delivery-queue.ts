import {
  validateCloudRequest,
  type CloudRequests,
  type CloudResponses,
} from "../src/shared/cloud-contract.js";
import { CloudClientError } from "./cloud-client.js";
import type { VaultSession } from "../src/store/vault-session.js";

// Delivery policy constants (§567 §2.1).
/** Base backoff interval for the first retry (30 s). */
export const RETRY_BASE_MS = 30_000;
/** Maximum number of delivery failures before an item is permanently discarded. */
export const MAX_ATTEMPTS = 4;
/** Items older than 7 days are discarded without delivery. */
export const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
/** Maximum number of items attempted per delivery pass. */
export const MAX_DELIVERY_BATCH = 10;

/**
 * In-flight guard: at most one delivery pass per session may run at a time.
 * Concurrent callers return immediately without starting a second pass, which
 * prevents double-sends and stale `attempts` counts from overlapping snapshots.
 */
const inFlightPasses = new WeakMap<VaultSession, Promise<void>>();

/**
 * Minimal client interface used by the delivery queue.
 * Only `feedback` and `outcome` operations are needed here.
 * `CloudClient` satisfies this interface.
 */
export interface DeliveryClient {
  call<K extends "feedback" | "outcome">(operation: K, request: CloudRequests[K]): Promise<CloudResponses[K]>;
}

/**
 * Pure: compute the epoch-ms at which the next delivery attempt should be made.
 * `attempts` is the current failure count (1-based after the first failure).
 * Schedule: 30 s, 60 s, 120 s (exponential, base 2).
 */
export function computeNextAttemptAt(attempts: number, now: number): number {
  return now + RETRY_BASE_MS * Math.pow(2, attempts - 1);
}

/**
 * Pure: true when the item is due to be attempted now.
 * Absent `nextAttemptAt` means the item was just enqueued and is immediately due.
 */
export function isDue(nextAttemptAt: number | undefined, now: number): boolean {
  return now >= (nextAttemptAt ?? 0);
}

/**
 * Pure: true when the item must be discarded without delivery.
 * `failReason` is the `CloudClientError.category` string, or empty for age/attempts checks only.
 */
export function shouldDiscard(
  failReason: string,
  attempts: number,
  enqueuedAt: number,
  now: number,
): boolean {
  if (attempts >= MAX_ATTEMPTS) return true;
  if (now - enqueuedAt > MAX_AGE_MS) return true;
  if (failReason === "budget-exhausted" || failReason === "ai-invalid-response") return true;
  return false;
}

/**
 * Re-read vault settings and remove the given key from the queue.
 * Reading right before writing avoids overwriting concurrent enqueues.
 */
function removeFromQueue(session: VaultSession, idempotencyKey: string): void {
  if (session.state !== "unlocked") return;
  const current = session.vault.get("cloudSettings", "cloud");
  if (!current) return;
  session.vault.put("cloudSettings", {
    ...current,
    queue: current.queue.filter((i) => i.idempotencyKey !== idempotencyKey),
    updatedAt: Date.now(),
  });
}

/**
 * Re-read vault settings and update the given item's attempts/nextAttemptAt.
 * Concurrent enqueues are preserved because the write is keyed by idempotencyKey.
 */
function updateQueueItem(
  session: VaultSession,
  idempotencyKey: string,
  attempts: number,
  nextAttemptAt: number,
): void {
  if (session.state !== "unlocked") return;
  const current = session.vault.get("cloudSettings", "cloud");
  if (!current) return;
  session.vault.put("cloudSettings", {
    ...current,
    queue: current.queue.map((i) =>
      i.idempotencyKey === idempotencyKey ? { ...i, attempts, nextAttemptAt } : i,
    ),
    updatedAt: Date.now(),
  });
}

/**
 * Attempt delivery of pending queue items in a single serial pass.
 *
 * - Skips items that are not yet due (backoff window not elapsed).
 * - Discards items that exceed MAX_ATTEMPTS or MAX_AGE_MS.
 * - Retries only on `cloud-unreachable` and `rate-limited`; discards on all other errors.
 *   Note: `CloudClient` maps every non-OK HTTP response — including 4xx such as
 *   `schema-retired` or `schema-not-found` — to `cloud-unreachable`, so those are
 *   retried up to MAX_ATTEMPTS times before being discarded.
 * - `idempotencyKey` values are reused across retries — never regenerated.
 * - Cloud writes are only attempted when `cloudAssistEnabled` is true. The off switch
 *   is re-checked before each individual `client.call` so that disabling cloud assistance
 *   mid-pass takes effect immediately.
 * - Does not modify the queue when the session is not unlocked.
 * - Only one pass per session runs at a time (see `inFlightPasses`).
 */
export async function deliverQueue(session: VaultSession, client: DeliveryClient): Promise<void> {
  if (inFlightPasses.has(session)) return;
  const pass = doDeliverQueue(session, client);
  inFlightPasses.set(session, pass);
  try {
    await pass;
  } finally {
    inFlightPasses.delete(session);
  }
}

async function doDeliverQueue(session: VaultSession, client: DeliveryClient): Promise<void> {
  if (session.state !== "unlocked") return;
  const initial = session.vault.get("cloudSettings", "cloud");
  if (!initial?.cloudAssistEnabled || !initial.queue.length) return;

  const now = Date.now();
  let processed = 0;
  let mutated = false;

  for (const item of initial.queue) {
    if (processed >= MAX_DELIVERY_BATCH) break;

    // Age-based or max-attempts discard — check before deciding to attempt.
    if (shouldDiscard("", item.attempts, item.enqueuedAt, now)) {
      removeFromQueue(session, item.idempotencyKey);
      mutated = true;
      processed++;
      continue;
    }

    if (!isDue(item.nextAttemptAt, now)) continue;

    const operation = item.kind === "feedback" ? ("feedback" as const) : ("outcome" as const);
    let outcome: "success" | "retryable" | "discard" = "discard";
    let failReason = "";

    try {
      validateCloudRequest(operation, item.body);
      // Re-check the off switch immediately before each network call: the user may
      // disable cloud assistance while a pass is in progress (after earlier awaits).
      if (!session.vault.get("cloudSettings", "cloud")?.cloudAssistEnabled) break;
      await client.call(operation, item.body as CloudRequests[typeof operation]);
      outcome = "success";
    } catch (err) {
      if (err instanceof CloudClientError) {
        failReason = err.category;
        if (err.category === "cloud-unreachable" || err.category === "rate-limited") {
          outcome = "retryable";
        }
        // budget-exhausted, ai-invalid-response -> discard (default)
      }
      // CloudContractError -> discard (default)
    }

    if (outcome === "success") {
      removeFromQueue(session, item.idempotencyKey);
      mutated = true;
    } else if (outcome === "retryable") {
      const newAttempts = item.attempts + 1;
      if (shouldDiscard(failReason, newAttempts, item.enqueuedAt, now)) {
        removeFromQueue(session, item.idempotencyKey);
      } else {
        updateQueueItem(session, item.idempotencyKey, newAttempts, computeNextAttemptAt(newAttempts, now));
      }
      mutated = true;
    } else {
      // discard: non-retryable error or contract validation failure
      removeFromQueue(session, item.idempotencyKey);
      mutated = true;
    }

    processed++;
  }

  if (mutated && session.state === "unlocked") {
    await session.save();
  }
}
