import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { createCloudServer } from "../dist/cloud/src/server.js";
import { TicketAuthority } from "../dist/cloud/src/tickets.js";
import { OUTCOME_TELEMETRY_SCHEMA, BigQueryTelemetryWriter } from "../dist/cloud/src/telemetry.js";

const hash = "a".repeat(64);

/** §15.3 exact field list — any divergence must be caught here. */
const SECTION_15_3_FIELDS = [
  "siteId",
  "formId",
  "schemaVersion",
  "operationType",
  "resolutionTier",
  "result",
  "errorCategory",
  "mappingConfidenceBucket",
  "clientVersion",
  "schemaFingerprint",
  "occurredAt",
];

test("OUTCOME_TELEMETRY_SCHEMA matches §15.3 exactly: same fields, REQUIRED mode, no free-text STRING for ids/times", () => {
  const names = OUTCOME_TELEMETRY_SCHEMA.map((f) => f.name);
  assert.deepEqual(names, SECTION_15_3_FIELDS, "field names and order must match §15.3");
  for (const field of OUTCOME_TELEMETRY_SCHEMA) {
    assert.equal(field.mode, "REQUIRED", `${field.name} must be REQUIRED`);
    assert.ok(
      ["STRING", "INTEGER", "TIMESTAMP"].includes(field.type),
      `${field.name} has unexpected type ${field.type}`,
    );
  }
  // schemaVersion must be INTEGER (not STRING) to prevent free-text injection.
  const versionField = OUTCOME_TELEMETRY_SCHEMA.find((f) => f.name === "schemaVersion");
  assert.equal(versionField?.type, "INTEGER");
  // occurredAt must be TIMESTAMP.
  const tsField = OUTCOME_TELEMETRY_SCHEMA.find((f) => f.name === "occurredAt");
  assert.equal(tsField?.type, "TIMESTAMP");
  // No fields outside §15.3 (no client id, IP, URL, labels, values, DOM).
  assert.equal(OUTCOME_TELEMETRY_SCHEMA.length, SECTION_15_3_FIELDS.length);
});

async function startWithTelemetry(t, writtenRows) {
  const logs = [];
  const server = createCloudServer({
    service: "api",
    budget: { consume: async () => true },
    tickets: new TicketAuthority("a".repeat(64)),
    feedback: { process: async () => ({ accepted: false }) },
    telemetry: {
      insert: async (event) => {
        writtenRows.push(event);
      },
    },
    log: (e) => logs.push(e),
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });
  const url = `http://127.0.0.1:${server.address().port}`;
  return {
    logs,
    post: (path, body) =>
      fetch(url + path, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      }),
  };
}

const validOutcome = {
  siteId: "example.com",
  formId: hash,
  schemaVersion: 1,
  operationType: "read",
  resolutionTier: "local_only",
  result: "handoff",
  errorCategory: "unknown",
  mappingConfidenceBucket: "unknown",
  clientVersion: "0.1.0",
  schemaFingerprint: hash,
  occurredAt: new Date(Math.floor(Date.now() / 3600000) * 3600000).toISOString(),
  idempotencyKey: "11111111-1111-4111-8111-111111111111",
};

test("outcome endpoint accepts valid event and returns 204 with no body", async (t) => {
  const written = [];
  const { post } = await startWithTelemetry(t, written);
  const res = await post("/v1/telemetry/outcome", validOutcome);
  assert.equal(res.status, 204);
  assert.equal(await res.text(), "");
  assert.equal(written.length, 1);
  assert.equal(written[0].siteId, "example.com");
});

test("outcome endpoint rejects unknown keys with 400 (unknown key must not enter BigQuery)", async (t) => {
  const written = [];
  const { post } = await startWithTelemetry(t, written);
  const res = await post("/v1/telemetry/outcome", { ...validOutcome, freeTextField: "any-value" });
  assert.equal(res.status, 400);
  assert.deepEqual(await res.json(), { error: "invalid-request" });
  assert.equal(written.length, 0);
});

test("outcome endpoint rejects free-string as formId (must be hash)", async (t) => {
  const written = [];
  const { post } = await startWithTelemetry(t, written);
  const res = await post("/v1/telemetry/outcome", { ...validOutcome, formId: "fake-free-text" });
  assert.equal(res.status, 400);
  assert.equal(written.length, 0);
});

test("outcome endpoint rejects non-hour-truncated timestamp", async (t) => {
  const written = [];
  const { post } = await startWithTelemetry(t, written);
  const nonTruncated = new Date(Date.now()).toISOString().replace(/:\d{2}\.\d{3}Z$/, ":01.000Z");
  const res = await post("/v1/telemetry/outcome", { ...validOutcome, occurredAt: nonTruncated });
  assert.equal(res.status, 400);
  assert.equal(written.length, 0);
});

test("outcome endpoint rejects invalid operationType enum value", async (t) => {
  const written = [];
  const { post } = await startWithTelemetry(t, written);
  const res = await post("/v1/telemetry/outcome", { ...validOutcome, operationType: "fake@example.com" });
  assert.equal(res.status, 400);
  assert.equal(written.length, 0);
});

test("outcome endpoint returns 503 when telemetry writer is not configured", async (t) => {
  const logs = [];
  const server = createCloudServer({
    service: "api",
    budget: { consume: async () => true },
    tickets: new TicketAuthority("a".repeat(64)),
    feedback: { process: async () => ({ accepted: false }) },
    // no telemetry option
    log: (e) => logs.push(e),
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });
  const res = await fetch(`http://127.0.0.1:${server.address().port}/v1/telemetry/outcome`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(validOutcome),
  });
  assert.equal(res.status, 503);
});

test("logs contain no site names or outcome field values after a valid outcome insert", async (t) => {
  const written = [];
  const { logs, post } = await startWithTelemetry(t, written);
  await post("/v1/telemetry/outcome", validOutcome);
  assert.doesNotMatch(JSON.stringify(logs), /example\.com/);
});

test("outcome endpoint writer storage failure returns body-free 503 without logging event content", async (t) => {
  const logs = [];
  const server = createCloudServer({
    service: "api",
    budget: { consume: async () => true },
    tickets: new TicketAuthority("a".repeat(64)),
    feedback: { process: async () => ({ accepted: false }) },
    telemetry: {
      insert: async () => {
        throw new Error("fake-private-bq-error");
      },
    },
    log: (e) => logs.push(e),
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });
  const res = await fetch(`http://127.0.0.1:${server.address().port}/v1/telemetry/outcome`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(validOutcome),
  });
  assert.equal(res.status, 503);
  assert.deepEqual(await res.json(), { error: "unavailable" });
  assert.doesNotMatch(JSON.stringify(logs), /private|example/);
});

test("outcome endpoint rejects missing idempotencyKey with 400", async (t) => {
  const written = [];
  const { post } = await startWithTelemetry(t, written);
  const { idempotencyKey: _, ...noKey } = validOutcome;
  const res = await post("/v1/telemetry/outcome", noKey);
  assert.equal(res.status, 400);
  assert.equal(written.length, 0);
});

test("outcome endpoint rejects invalid idempotencyKey with 400", async (t) => {
  const written = [];
  const { post } = await startWithTelemetry(t, written);
  const res = await post("/v1/telemetry/outcome", { ...validOutcome, idempotencyKey: "not-a-uuid" });
  assert.equal(res.status, 400);
  assert.equal(written.length, 0);
});

test("BigQueryTelemetryWriter.insert passes idempotencyKey as insertId in raw mode", async () => {
  const captured = [];
  const fakeBq = {
    dataset: () => ({
      table: () => ({
        insert: async (rows, opts) => {
          captured.push({ rows, opts });
        },
      }),
    }),
  };
  const writer = new BigQueryTelemetryWriter("fake-project", "fake-dataset", "fake-table", fakeBq);
  await writer.insert(validOutcome);
  assert.equal(captured.length, 1);
  assert.deepEqual(captured[0].opts, { raw: true });
  assert.equal(captured[0].rows.length, 1);
  assert.equal(captured[0].rows[0].insertId, validOutcome.idempotencyKey);
  // The json field must contain only §15.3 fields (no idempotencyKey in the row data).
  assert.ok("json" in captured[0].rows[0]);
  assert.equal(captured[0].rows[0].json.siteId, validOutcome.siteId);
  assert.equal(captured[0].rows[0].json.idempotencyKey, undefined);
});
