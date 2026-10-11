import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  FirestoreSchemaRegistry,
  validateStoredSchema,
  publicSchema,
} from "../dist/cloud/src/schema-registry.js";
const [seed] = JSON.parse(await readFile(new URL("../seeds/official.json", import.meta.url), "utf8"));
// External Firestore is replaced at the registry boundary; the real validation/selection/HTTP code runs.
function database(records = []) {
  const documents = new Map(records.map((r) => [r.schemaId, structuredClone(r)]));
  let writes = 0;
  return {
    documents,
    get writes() {
      return writes;
    },
    collection(name) {
      assert.equal(name, "formSchemas");
      return {
        doc(id) {
          return { id };
        },
        where(field, op, print) {
          assert.equal(field, "pageFingerprints");
          assert.equal(op, "array-contains");
          return {
            async get() {
              return {
                docs: [...documents]
                  .filter(([, r]) => r.pageFingerprints.includes(print))
                  .map(([id, r]) => ({ id, data: () => structuredClone(r) })),
              };
            },
          };
        },
      };
    },
    async runTransaction(fn) {
      return fn({
        async get(ref) {
          return { exists: documents.has(ref.id), data: () => documents.get(ref.id) };
        },
        set(ref, record) {
          writes++;
          documents.set(ref.id, structuredClone(record));
        },
      });
    },
  };
}
test("official fixture has a closed value-free schema; unsafe writes never reach storage", async () => {
  const db = database();
  const registry = new FirestoreSchemaRegistry(db);
  validateStoredSchema(seed);
  for (const anchor of ["#email", '[value="fake@example.com"]', ".customer", ":root > input", "f-0"]) {
    await assert.rejects(registry.save({ ...seed, fields: [{ ...seed.fields[0], anchor }] }));
  }
  for (const site of ["fake@example.com", "090-1234-5678.example", "4111111111111111.example"])
    await assert.rejects(registry.save({ ...seed, site }));
  for (const field of ["schemaId", "formKey", "createdAt", "updatedAt", "provenance"])
    await assert.rejects(registry.save({ ...seed, [field]: "fake@example.com" }));
  await assert.rejects(registry.save({ ...seed, rawValue: "fake-private" }));
  assert.equal(db.writes, 0);
  await registry.save(seed);
  await registry.save(structuredClone(seed));
  assert.equal(db.documents.size, 1);
  await assert.rejects(
    registry.save({ ...seed, fields: [{ ...seed.fields[0], attributeKey: "name.full" }] }),
    /version-conflict/,
  );
});
test("resolve isolates sites/fingerprints, ignores inactive/corrupt records, selects newest version", async () => {
  const db = database([seed]);
  const registry = new FirestoreSchemaRegistry(db);
  const request = { site: seed.site, pageFingerprint: seed.pageFingerprints[0], clientVersion: "0.1.2" };
  assert.deepEqual(await registry.resolve(request), publicSchema(seed));
  assert.equal(await registry.resolve({ ...request, site: "other.example" }), null);
  assert.equal(await registry.resolve({ ...request, pageFingerprint: "a".repeat(64) }), null);
  await registry.save({ ...seed, schemaId: "b".repeat(64), version: 2 });
  assert.equal((await registry.resolve(request)).version, 2);
  db.documents.set("c".repeat(64), { ...seed, schemaId: "c".repeat(64), version: 3, status: "candidate" });
  db.documents.set("d".repeat(64), {
    ...seed,
    schemaId: "d".repeat(64),
    version: 4,
    fields: [{ anchor: "#value", attributeKey: "email", required: true }],
  });
  assert.equal((await registry.resolve(request)).version, 2);
});

test("schema writes snapshot the validated record before awaiting storage", async () => {
  const db = database();
  const registry = new FirestoreSchemaRegistry(db);
  const value = structuredClone(seed);
  const saving = registry.save(value);
  value.fields[0].anchor = "#fake-private";
  await saving;
  assert.equal(db.documents.get(seed.schemaId).fields[0].anchor, "f-1");
});
