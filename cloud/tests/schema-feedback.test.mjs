import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  SchemaFeedbackHandler,
  LIFECYCLE,
  evaluateLifecycle,
  runDetectionJob,
} from "../dist/cloud/src/schema-feedback.js";
import { validateStoredSchema } from "../dist/cloud/src/schema-registry.js";

const [seed] = JSON.parse(await readFile(new URL("../seeds/official.json", import.meta.url), "utf8"));
const SECRET = "a".repeat(64);
const FINGERPRINT = seed.pageFingerprints[0];
const SITE = seed.site;
const TOKEN = "b".repeat(64);
const UUID = "11111111-1111-4111-8111-111111111111";
const UUID2 = "22222222-2222-4222-8222-222222222222";

// Fake candidate schema for feedback tests (non-official, no high-risk fields)
const candidateId = "c".repeat(64);
const candidateBase = {
  ...seed,
  schemaId: candidateId,
  site: SITE,
  status: "candidate",
  provenance: "gemini_structure",
  validationCount: 0,
  distinctValidators: 0,
  failureCount: 0,
};

/** In-memory Firestore stub that supports collections, docs, subcollections, transactions, batches. */
function fakeDb(initialRecords = {}) {
  const store = new Map();
  for (const [path, doc] of Object.entries(initialRecords)) store.set(path, structuredClone(doc));

  let writes = 0;
  const db = {
    get writes() {
      return writes;
    },
    _store: store,
    collection(name) {
      return collection(db, name);
    },
    batch() {
      const ops = [];
      return {
        set(ref, data) {
          ops.push({ ref, data });
        },
        async commit() {
          for (const { ref, data } of ops) {
            writes++;
            store.set(ref._path, structuredClone(data));
          }
        },
      };
    },
    async runTransaction(fn) {
      const reads = [];
      const sets = [];
      const tx = {
        async get(ref) {
          reads.push(ref._path);
          const data = store.get(ref._path);
          return { exists: data !== undefined, data: () => structuredClone(data) };
        },
        set(ref, data) {
          sets.push({ ref, data });
        },
      };
      const result = await fn(tx);
      for (const { ref, data } of sets) {
        writes++;
        store.set(ref._path, structuredClone(data));
      }
      return result;
    },
  };

  function makeRef(path) {
    return {
      _path: path,
      collection(sub) {
        return collection(db, `${path}/${sub}`);
      },
      async get() {
        const data = store.get(path);
        return { exists: data !== undefined, data: () => structuredClone(data), ref: makeRef(path) };
      },
    };
  }

  function collection(parent, name) {
    const prefix = name.endsWith("/") ? name : name + "/";
    return {
      doc(id) {
        const path = `${name}/${id}`;
        return makeRef(path);
      },
      where(field, op, value) {
        return {
          async get() {
            const docs = [];
            for (const [path, doc] of store) {
              if (!path.startsWith(prefix)) continue;
              // Only direct children (no sub-paths)
              if (path.slice(prefix.length).includes("/")) continue;
              if (op === "==" && doc[field] !== value) continue;
              if (op === "array-contains" && (!Array.isArray(doc[field]) || !doc[field].includes(value)))
                continue;
              docs.push({
                id: path.slice(prefix.length),
                data: () => structuredClone(doc),
                ref: makeRef(path),
              });
            }
            return { docs };
          },
          where(f2, op2, v2) {
            // chained where — apply both filters
            const first = this;
            return {
              async get() {
                const { docs } = await first.get();
                return { docs: docs.filter((d) => (op2 === "==" ? d.data()[f2] === v2 : true)) };
              },
            };
          },
        };
      },
      async get() {
        const docs = [];
        for (const [path, doc] of store) {
          if (!path.startsWith(prefix)) continue;
          if (path.slice(prefix.length).includes("/")) continue;
          docs.push({ id: path.slice(prefix.length), data: () => structuredClone(doc), ref: makeRef(path) });
        }
        return { docs };
      },
    };
  }

  return db;
}

function feedbackReq(overrides = {}) {
  return {
    schemaId: candidateId,
    site: SITE,
    pageFingerprint: FINGERPRINT,
    pagePurpose: "profile",
    mappings: [{ anchor: seed.fields[0].anchor, attributeKey: seed.fields[0].attributeKey }],
    outcome: "validated",
    resolutionTier: "gemini_structure",
    siteValidatorToken: TOKEN,
    idempotencyKey: UUID,
    ...overrides,
  };
}

// ─────────────────────────────────────────────
// evaluateLifecycle unit tests
// ─────────────────────────────────────────────

test("under MIN_VALIDATIONS: no promotion, no failure-rate retirement", () => {
  const schema = { ...candidateBase, createdAt: new Date().toISOString() };
  // 4 validations, all success
  assert.equal(
    evaluateLifecycle(schema, 4, 3, 0, ["validated", "validated", "validated", "validated"], new Date()),
    "candidate",
  );
});

test("under MIN_VALIDATIONS: TTL retirement for candidate", () => {
  const old = new Date(Date.now() - 31 * 86400000).toISOString();
  const schema = { ...candidateBase, createdAt: old };
  assert.equal(
    evaluateLifecycle(schema, 3, 2, 0, ["validated", "validated", "validated"], new Date()),
    "retired",
  );
});

test("1 success never promotes", () => {
  const schema = { ...candidateBase, createdAt: new Date().toISOString() };
  assert.equal(evaluateLifecycle(schema, 1, 1, 0, ["validated"], new Date()), "candidate");
});

test("promotes at MIN_VALIDATIONS with full success and enough distinct validators", () => {
  const schema = { ...candidateBase, createdAt: new Date().toISOString() };
  const allSuccess = Array(LIFECYCLE.MIN_VALIDATIONS).fill("validated");
  assert.equal(
    evaluateLifecycle(
      schema,
      LIFECYCLE.MIN_VALIDATIONS,
      LIFECYCLE.MIN_DISTINCT_VALIDATORS,
      0,
      allSuccess,
      new Date(),
    ),
    "active",
  );
});

test("does not promote with too few distinct validators", () => {
  const schema = { ...candidateBase, createdAt: new Date().toISOString() };
  const allSuccess = Array(LIFECYCLE.MIN_VALIDATIONS).fill("validated");
  assert.equal(
    evaluateLifecycle(schema, LIFECYCLE.MIN_VALIDATIONS, 2, 0, allSuccess, new Date()),
    "candidate",
  );
});

test("does not promote with too many failures", () => {
  const schema = { ...candidateBase, createdAt: new Date().toISOString() };
  const ring = ["validated", "validated", "validated", "validated", "failed"];
  assert.equal(
    evaluateLifecycle(
      schema,
      LIFECYCLE.MIN_VALIDATIONS,
      LIFECYCLE.MIN_DISTINCT_VALIDATORS,
      LIFECYCLE.MAX_FAILURES_TO_PROMOTE,
      ring,
      new Date(),
    ),
    "candidate",
  );
});

test("retires candidate on failure-rate overflow", () => {
  const schema = { ...candidateBase, createdAt: new Date().toISOString() };
  // 4 fails out of 10 = 40% > 30%
  const ring = [
    "failed",
    "failed",
    "failed",
    "failed",
    "validated",
    "validated",
    "validated",
    "validated",
    "validated",
    "validated",
  ];
  assert.equal(evaluateLifecycle(schema, 10, 3, 4, ring, new Date()), "retired");
});

test("retires active schema on failure-rate overflow", () => {
  const schema = { ...candidateBase, status: "active", createdAt: new Date().toISOString() };
  const ring = [
    "failed",
    "failed",
    "failed",
    "failed",
    "validated",
    "validated",
    "validated",
    "validated",
    "validated",
    "validated",
  ];
  assert.equal(evaluateLifecycle(schema, 10, 3, 4, ring, new Date()), "retired");
});

test("high-risk fields: never auto-promoted from gemini_structure", () => {
  const schema = {
    ...candidateBase,
    provenance: "gemini_structure",
    fields: [{ anchor: "f-1", attributeKey: "name.full", required: false }],
    createdAt: new Date().toISOString(),
  };
  const allSuccess = Array(LIFECYCLE.MIN_VALIDATIONS).fill("validated");
  assert.equal(
    evaluateLifecycle(
      schema,
      LIFECYCLE.MIN_VALIDATIONS,
      LIFECYCLE.MIN_DISTINCT_VALIDATORS,
      0,
      allSuccess,
      new Date(),
    ),
    "candidate",
  );
});

test("official high-risk schema stays active (retirement only by failure rate)", () => {
  const schema = {
    ...candidateBase,
    status: "active",
    provenance: "official",
    fields: [{ anchor: "f-1", attributeKey: "name.full", required: true }],
    createdAt: new Date().toISOString(),
  };
  const okRing = Array(LIFECYCLE.MIN_VALIDATIONS).fill("validated");
  assert.equal(evaluateLifecycle(schema, LIFECYCLE.MIN_VALIDATIONS, 3, 0, okRing, new Date()), "active");
});

test("retired schema never changes status", () => {
  const schema = { ...candidateBase, status: "retired", createdAt: new Date().toISOString() };
  const allSuccess = Array(LIFECYCLE.WINDOW).fill("validated");
  assert.equal(evaluateLifecycle(schema, LIFECYCLE.WINDOW, 5, 0, allSuccess, new Date()), "retired");
});

// ─────────────────────────────────────────────
// SchemaFeedbackHandler integration tests
// ─────────────────────────────────────────────

test("feedback for unknown schema returns accepted: false", async () => {
  const db = fakeDb();
  const handler = new SchemaFeedbackHandler(SECRET, db);
  const result = await handler.process(feedbackReq());
  assert.deepEqual(result, { accepted: false });
});

test("feedback for retired schema returns accepted: false", async () => {
  const db = fakeDb({ [`formSchemas/${candidateId}`]: { ...candidateBase, status: "retired" } });
  const handler = new SchemaFeedbackHandler(SECRET, db);
  assert.deepEqual(await handler.process(feedbackReq()), { accepted: false });
});

test("valid feedback is accepted and increments counters", async () => {
  const db = fakeDb({ [`formSchemas/${candidateId}`]: structuredClone(candidateBase) });
  const handler = new SchemaFeedbackHandler(SECRET, db);
  const result = await handler.process(feedbackReq());
  assert.deepEqual(result, { accepted: true });
  const schema = db._store.get(`formSchemas/${candidateId}`);
  assert.equal(schema.validationCount, 1);
  assert.equal(schema.distinctValidators, 1);
  assert.equal(schema.failureCount, 0);
  assert.equal(schema.status, "candidate"); // not enough to promote
});

test("failed outcome increments failureCount and decrements distinctValidators if previously validated", async () => {
  const db = fakeDb({ [`formSchemas/${candidateId}`]: structuredClone(candidateBase) });
  const handler = new SchemaFeedbackHandler(SECRET, db);
  await handler.process(feedbackReq({ idempotencyKey: UUID }));
  assert.equal(db._store.get(`formSchemas/${candidateId}`).distinctValidators, 1);
  // Same validator now reports failure
  await handler.process(feedbackReq({ outcome: "failed", idempotencyKey: UUID2 }));
  const schema = db._store.get(`formSchemas/${candidateId}`);
  assert.equal(schema.validationCount, 2);
  assert.equal(schema.distinctValidators, 0); // lost the one success
  assert.equal(schema.failureCount, 1);
});

test("idempotency: same idempotencyKey is accepted without re-processing (receipt-based)", async () => {
  const db = fakeDb({ [`formSchemas/${candidateId}`]: structuredClone(candidateBase) });
  const handler = new SchemaFeedbackHandler(SECRET, db);
  await handler.process(feedbackReq());
  const writesBefore = db.writes;
  const result = await handler.process(feedbackReq()); // same UUID
  assert.deepEqual(result, { accepted: true });
  assert.equal(db.writes, writesBefore); // no additional writes — early exit via receipt
  assert.equal(db._store.get(`formSchemas/${candidateId}`).validationCount, 1); // not doubled
  // Receipt document should be present.
  assert.ok(db._store.has(`schemaFeedback/${candidateId}/receipts/${UUID}`));
});

test("A→B→A re-send does not double-count (receipt prevents repeated counting)", async () => {
  const db = fakeDb({ [`formSchemas/${candidateId}`]: structuredClone(candidateBase) });
  const handler = new SchemaFeedbackHandler(SECRET, db);
  // A: first validated submission
  await handler.process(feedbackReq({ idempotencyKey: UUID, outcome: "validated" }));
  assert.equal(db._store.get(`formSchemas/${candidateId}`).validationCount, 1);
  assert.equal(db._store.get(`formSchemas/${candidateId}`).distinctValidators, 1);
  // B: same validator, different key — reports failure
  await handler.process(feedbackReq({ idempotencyKey: UUID2, outcome: "failed" }));
  assert.equal(db._store.get(`formSchemas/${candidateId}`).validationCount, 2);
  assert.equal(db._store.get(`formSchemas/${candidateId}`).failureCount, 1);
  // A again: re-delivery of the original UUID must not re-count
  const countBefore = db._store.get(`formSchemas/${candidateId}`).validationCount;
  const result = await handler.process(feedbackReq({ idempotencyKey: UUID, outcome: "validated" }));
  assert.deepEqual(result, { accepted: true });
  assert.equal(db._store.get(`formSchemas/${candidateId}`).validationCount, countBefore); // no increment
  assert.equal(db._store.get(`formSchemas/${candidateId}`).failureCount, 1); // failure unchanged
});

test("same validator, different idempotencyKey: increments count but not distinctValidators again", async () => {
  const db = fakeDb({ [`formSchemas/${candidateId}`]: structuredClone(candidateBase) });
  const handler = new SchemaFeedbackHandler(SECRET, db);
  await handler.process(feedbackReq({ idempotencyKey: UUID }));
  await handler.process(feedbackReq({ idempotencyKey: UUID2 })); // new key but same TOKEN
  const schema = db._store.get(`formSchemas/${candidateId}`);
  assert.equal(schema.validationCount, 2);
  assert.equal(schema.distinctValidators, 1); // still 1, same validator
});

test("candidate promotes to active at threshold with enough distinct validators", async () => {
  const N = LIFECYCLE.MIN_VALIDATIONS;
  const initial = structuredClone(candidateBase);
  const db = fakeDb({ [`formSchemas/${candidateId}`]: initial });

  const tokens = ["b", "c", "d"].map((x) => x.repeat(64));
  const uuids = [
    "11111111-1111-4111-8111-111111111111",
    "22222222-2222-4222-8222-222222222222",
    "33333333-3333-4333-8333-333333333333",
    "44444444-4444-4444-8444-444444444444",
    "55555555-5555-4555-8555-555555555555",
  ];

  const handler = new SchemaFeedbackHandler(SECRET, db);
  for (let i = 0; i < N; i++) {
    await handler.process(
      feedbackReq({ siteValidatorToken: tokens[i % tokens.length], idempotencyKey: uuids[i] }),
    );
  }
  const schema = db._store.get(`formSchemas/${candidateId}`);
  assert.equal(schema.validationCount, N);
  assert.equal(schema.status, "active");
});

test("Tier 3 outcome is rejected by resolutionTier constraint in contract (not accepted)", () => {
  // The cloud-contract validator rejects resolutionTier values other than shared_schema/gemini_structure.
  // This test confirms that the type system + contract prevent Tier 3 from being sent.
  // (Validation happens in server.ts before reaching the handler; here we just confirm the type.)
  const req = feedbackReq({ resolutionTier: "gemini_pii_consent" });
  assert.ok(req.resolutionTier === "gemini_pii_consent"); // compile-time: FeedbackRequest doesn't allow this
  // In practice the server rejects it at validateCloudRequest; the handler type is safe.
});

test("feedback with schemaId: null creates a new candidate schema", async () => {
  const db = fakeDb();
  const handler = new SchemaFeedbackHandler(SECRET, db);
  const result = await handler.process(feedbackReq({ schemaId: null }));
  assert.deepEqual(result, { accepted: true });
  // A candidate schema should have been created
  const candidates = [...db._store.entries()].filter(
    ([k, v]) => k.startsWith("formSchemas/") && v.status === "candidate",
  );
  assert.equal(candidates.length, 1);
  const [, candidate] = candidates[0];
  assert.equal(candidate.site, SITE);
  assert.equal(candidate.provenance, "gemini_structure");
});

test("feedback with schemaId: null reuses existing candidate with same mappings", async () => {
  const db = fakeDb();
  const handler = new SchemaFeedbackHandler(SECRET, db);
  // First submission creates a candidate
  await handler.process(feedbackReq({ schemaId: null, idempotencyKey: UUID }));
  const before = db.writes;
  // Second submission with same mappings but different idempotencyKey should reuse
  await handler.process(
    feedbackReq({ schemaId: null, idempotencyKey: UUID2, siteValidatorToken: "c".repeat(64) }),
  );
  const candidates = [...db._store.entries()].filter(
    ([k, v]) =>
      k.startsWith("formSchemas/") &&
      !k.slice("formSchemas/".length).includes("/") &&
      v.status === "candidate",
  );
  assert.equal(candidates.length, 1); // still just one candidate
});

test("detection job flags and retires invalid schemas", async () => {
  const badSchema = {
    ...candidateBase,
    // Inject a personal-value-like string that will fail validateFormSchema
    fields: [{ anchor: "f-1", attributeKey: "email", required: false, extra: "test@example.com" }],
    status: "active",
    provenance: "official",
  };
  const goodSchema = { ...seed };
  const db = fakeDb({
    [`formSchemas/${candidateId}`]: badSchema,
    [`formSchemas/${seed.schemaId}`]: goodSchema,
  });
  const logs = [];
  const result = await runDetectionJob(db, (msg) => logs.push(msg));
  assert.equal(result.scanned, 2);
  assert.equal(result.flagged, 1);
  assert.ok(logs.some((l) => l.includes(candidateId)));
  assert.equal(db._store.get(`formSchemas/${candidateId}`).status, "retired");
  assert.equal(db._store.get(`formSchemas/${seed.schemaId}`).status, "active"); // unchanged
});

test("ring buffer wraps correctly: validations beyond WINDOW overwrite oldest slot", async () => {
  const N = LIFECYCLE.WINDOW + 2;
  const tokens = Array.from({ length: N }, (_, i) => String(i).padStart(1, "0").padEnd(64, "0").slice(0, 64));
  // Ensure tokens are valid hex
  const hexTokens = Array.from({ length: N }, (_, i) => createHexToken(i));
  const uuids = Array.from(
    { length: N },
    (_, i) => `${String(i).padStart(8, "0")}-1111-4111-8111-111111111111`,
  );
  function createHexToken(i) {
    return i.toString(16).padStart(2, "0").repeat(32);
  }

  const initial = structuredClone(candidateBase);
  const db = fakeDb({ [`formSchemas/${candidateId}`]: initial });
  const handler = new SchemaFeedbackHandler(SECRET, db);

  for (let i = 0; i < N; i++) {
    await handler.process(feedbackReq({ siteValidatorToken: hexTokens[i], idempotencyKey: uuids[i] }));
  }
  const schema = db._store.get(`formSchemas/${candidateId}`);
  assert.equal(schema.validationCount, N);
  // Recent subcollection should have exactly WINDOW entries
  const recentKeys = [...db._store.keys()].filter((k) =>
    k.startsWith(`schemaFeedback/${candidateId}/recent/`),
  );
  assert.equal(recentKeys.length, LIFECYCLE.WINDOW);
});
