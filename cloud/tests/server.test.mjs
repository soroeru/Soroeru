import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { createHash } from "node:crypto";
import { createCloudServer } from "../dist/cloud/src/server.js";
import { TicketAuthority } from "../dist/cloud/src/tickets.js";
import { tier3PayloadJson } from "../dist/src/shared/cloud-contract.js";
const secret = "a".repeat(64);
const hash = "a".repeat(64);
const uuid = "11111111-1111-4111-8111-111111111111";
async function start(t, options = {}) {
  const logs = [];
  const server = createCloudServer({
    service: "api",
    budget: { consume: async () => true },
    tickets: new TicketAuthority(secret),
    log: (e) => logs.push(e),
    ...options,
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
    post: (path, body, init = {}) =>
      fetch(url + path, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        ...init,
      }),
  };
}
test("real HTTP: route/service isolation, closed schema and body-free logs", async (t) => {
  const { logs, post } = await start(t);
  const payload = { site: "example.com", pageFingerprint: hash, clientVersion: "0.1.0" };
  const good = await post("/v1/schemas/resolve", payload);
  assert.equal(good.status, 200);
  assert.deepEqual(await good.json(), { schema: null, status: "none" });
  assert.equal((await post("/v1/schemas/resolve", { ...payload, value: "fake-password" })).status, 400);
  assert.equal((await post("/v1/schemas/resolve", payload, { method: "PUT" })).status, 405);
  assert.equal((await post("/v1/schemas/resolve?site=example.com", payload)).status, 404);
  assert.equal((await post("/v1/agent/read-with-consent", payload)).status, 404);
  for (const entry of logs) assert.deepEqual(Object.keys(entry).sort(), ["errorCategory", "latencyMs"]);
  assert.doesNotMatch(JSON.stringify(logs), /fake-password|example.com|11111111/);
});
test("request byte ceilings reject before business processing", async (t) => {
  const { post } = await start(t);
  assert.equal((await post("/v1/schemas/resolve", { value: "x".repeat(65536) })).status, 413);
});
test("budget cap returns 429 for both Tier 2 and ticket issuance", async (t) => {
  let count = 0;
  const { post } = await start(t, { budget: { consume: async () => ++count <= 1 } });
  const ticket = { consentId: uuid, site: "example.com", payloadSha256: hash };
  assert.equal((await post("/v1/agent/tier3-ticket", ticket)).status, 200);
  const exhausted = await post("/v1/agent/map-structure", {
    site: "example.com",
    pageFingerprint: hash,
    purposeHint: "profile",
    items: [{ id: "f-1", tag: "input", nameTokens: [] }],
  });
  assert.equal(exhausted.status, 429);
  assert.deepEqual(await exhausted.json(), { error: "budget-exhausted" });
});
test("budget storage failures return a body-free 503", async (t) => {
  const { logs, post } = await start(t, {
    budget: {
      consume: async () => {
        throw new Error("fake-private-db-error");
      },
    },
  });
  const response = await post("/v1/agent/tier3-ticket", {
    consentId: uuid,
    site: "example.com",
    payloadSha256: hash,
  });
  assert.equal(response.status, 503);
  assert.doesNotMatch(JSON.stringify(logs), /private|example/);
});
test("tickets bind site, consent and exact payload; replay and expiry fail closed", async (t) => {
  let now = 1000000;
  const authority = new TicketAuthority(secret, () => now);
  const payload = {
    consentId: uuid,
    site: "example.com",
    requestedKeys: ["email"],
    items: [{ id: "d-1", text: "fake@example.com" }],
  };
  const ticket = authority.issue({
    consentId: uuid,
    site: payload.site,
    payloadSha256: createHash("sha256").update(tier3PayloadJson(payload)).digest("hex"),
  }).ticket;
  const { post } = await start(t, { service: "pii-fallback", tickets: authority });
  assert.equal(
    (await post("/v1/agent/read-with-consent", { ...payload, site: "other.example.com", ticket })).status,
    403,
  );
  assert.equal(
    (
      await post("/v1/agent/read-with-consent", {
        ...payload,
        items: [{ id: "d-1", text: "changed" }],
        ticket,
      })
    ).status,
    403,
  );
  assert.equal((await post("/v1/agent/read-with-consent", { ...payload, ticket })).status, 200);
  assert.equal((await post("/v1/agent/read-with-consent", { ...payload, ticket })).status, 403);
  const next = authority.issue({
    consentId: uuid,
    site: payload.site,
    payloadSha256: createHash("sha256").update(tier3PayloadJson(payload)).digest("hex"),
  }).ticket;
  now += 300000;
  assert.equal(authority.consume({ ...payload, ticket: next }), false);
  assert.equal((await post("/v1/schemas/resolve", {})).status, 404);
});
test("rate limiter ignores spoofed forwarding headers and refills by elapsed time", async (t) => {
  let now = 0;
  const { post } = await start(t, { rateLimit: 1, now: () => now });
  const body = { site: "example.com", pageFingerprint: hash, clientVersion: "0.1.0" };
  assert.equal((await post("/v1/schemas/resolve", body)).status, 200);
  assert.equal(
    (
      await post("/v1/schemas/resolve", body, {
        headers: { "Content-Type": "application/json", "X-Forwarded-For": "203.0.113.1" },
      })
    ).status,
    429,
  );
  now += 60000;
  assert.equal((await post("/v1/schemas/resolve", body)).status, 200);
});
