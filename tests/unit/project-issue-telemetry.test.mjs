import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import {
  aggregateTokenUsage,
  migrateTelemetryEvent,
  validateTelemetryEvent,
} from "../../scripts/project-issue-telemetry.mjs";

const fixture = async (name) =>
  JSON.parse(await readFile(new URL(`../fixtures/project-issue-telemetry/${name}`, import.meta.url), "utf8"));

test("validates common route, role, and terminal events and joins them by correlation ID", async () => {
  const events = await fixture("valid-v1.json");

  const validated = events.map(validateTelemetryEvent);

  assert.equal(new Set(validated.map(({ correlationId }) => correlationId)).size, 1);
  assert.deepEqual(validated[0].payload.candidates.map(({ agent }) => agent), [
    "Codex",
    "Claude",
    "Grok",
    "Gemini",
  ]);
  assert.deepEqual(aggregateTokenUsage(validated), {
    byIssue: { "9001": { exact: 100, estimate: 40, unavailable: 1 } },
    byRole: { implementer: { exact: 100, estimate: 40, unavailable: 1 } },
  });
});

test("accepts unavailable provider usage without inventing a numeric value", async () => {
  const events = await fixture("valid-v1.json");
  const roleEvent = events.find(({ type }) => type === "role_execution");

  const validated = validateTelemetryEvent(roleEvent);

  assert.deepEqual(validated.payload.tokens.total, {
    availability: "unavailable",
    reasonCode: "provider_not_exposed",
  });
});

test("rejects prohibited content anywhere in an event", async () => {
  const [event] = await fixture("valid-v1.json");

  assert.throws(
    () => validateTelemetryEvent({ ...event, payload: { ...event.payload, prompt: "secret" } }),
    /privacy-prohibited-field:payload\.prompt/,
  );
  assert.throws(
    () => validateTelemetryEvent({ ...event, payload: { ...event.payload, nested: { credentials: "secret" } } }),
    /privacy-prohibited-field:payload\.nested\.credentials/,
  );
});

test("migrates the documented legacy fixture to the current schema", async () => {
  const legacy = await fixture("legacy-v0.json");

  const migrated = migrateTelemetryEvent(legacy);

  assert.equal(migrated.schemaVersion, 1);
  assert.equal(migrated.correlationId, "run-legacy-1");
  assert.equal(validateTelemetryEvent(migrated).payload.status, "failed");
});

test("records closed duplicate, abandoned, timeout, and failed-handoff waste reasons", async () => {
  const events = await fixture("valid-v1.json");
  const terminal = events.find(({ type }) => type === "terminal_outcome");
  const accepted = ["duplicate_node_execution", "abandoned_worker", "timeout", "failed_handoff"];

  for (const reason of accepted) {
    assert.doesNotThrow(() =>
      validateTelemetryEvent({
        ...terminal,
        eventId: `evt-${reason}`,
        payload: { ...terminal.payload, failureReasonCode: reason, wasteReasonCodes: [reason] },
      }),
    );
  }
  assert.throws(
    () => validateTelemetryEvent({ ...terminal, payload: { ...terminal.payload, failureReasonCode: "free text" } }),
    /invalid-failure-reason-code/,
  );
});
