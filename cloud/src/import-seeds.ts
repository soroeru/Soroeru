import { readFile } from "node:fs/promises";
import { FirestoreSchemaRegistry, validateStoredSchema } from "./schema-registry.js";

// Maintainer-only CLI; public API has no schema-write route. No fixture values enter Firestore.
const [path, reviewed] = process.argv.slice(2);
if (!path || reviewed !== "--reviewed") throw new Error("usage: import-seeds <manifest.json> --reviewed");
let records: unknown;
try {
  records = JSON.parse(await readFile(path, "utf8"));
} catch {
  throw new Error("invalid-seed-manifest");
}
if (!Array.isArray(records) || records.length < 1 || records.length > 200)
  throw new Error("invalid-seed-manifest");
// Validate the entire manifest before the first write; re-running an unchanged manifest is idempotent.
for (const record of records) {
  validateStoredSchema(record);
  if (record.status !== "active" || record.provenance !== "official")
    throw new Error("invalid-official-seed");
}
const registry = new FirestoreSchemaRegistry();
for (const record of records) await registry.save(record);
process.stdout.write(`Imported ${records.length} reviewed schemas.\n`);
