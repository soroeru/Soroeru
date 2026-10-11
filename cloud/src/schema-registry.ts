import { isDeepStrictEqual } from "node:util";
import { Firestore } from "@google-cloud/firestore";
import { validateFormSchema, type FormSchema, type ResolveRequest } from "../../src/shared/cloud-contract.js";

export interface StoredFormSchema extends FormSchema {
  validationCount: number;
  distinctValidators: number;
  failureCount: number;
  createdAt: string;
  updatedAt: string;
}
export function validateStoredSchema(value: unknown): asserts value is StoredFormSchema {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid-schema-record");
  const { validationCount, distinctValidators, failureCount, createdAt, updatedAt, ...schema } =
    value as StoredFormSchema;
  validateFormSchema(schema);
  for (const n of [validationCount, distinctValidators, failureCount])
    if (!Number.isSafeInteger(n) || n < 0) throw new Error("invalid-schema-record");
  for (const date of [createdAt, updatedAt])
    if (
      typeof date !== "string" ||
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(date) ||
      !Number.isFinite(Date.parse(date)) ||
      new Date(date).toISOString() !== date
    )
      throw new Error("invalid-schema-record");
  if (updatedAt < createdAt || distinctValidators > validationCount) throw new Error("invalid-schema-record");
}
export function publicSchema(value: StoredFormSchema): FormSchema {
  return {
    schemaId: value.schemaId,
    site: value.site,
    formKey: value.formKey,
    version: value.version,
    pageFingerprints: value.pageFingerprints,
    fields: value.fields,
    confidence: value.confidence,
    status: value.status,
    provenance: value.provenance,
  };
}
export interface SchemaRegistry {
  resolve(request: ResolveRequest): Promise<FormSchema | null>;
}
/** All writes pass the same closed-schema/privacy validation as reads. No public write route. */
export class FirestoreSchemaRegistry implements SchemaRegistry {
  constructor(private readonly db = new Firestore()) {}
  async save(value: StoredFormSchema): Promise<void> {
    value = structuredClone(value); // The caller cannot change a validated write while the transaction awaits.
    validateStoredSchema(value);
    const ref = this.db.collection("formSchemas").doc(value.schemaId);
    await this.db.runTransaction(async (tx) => {
      const old = await tx.get(ref);
      if (old.exists) {
        const data: unknown = old.data();
        validateStoredSchema(data);
        if (
          data.version > value.version ||
          (data.version === value.version && !isDeepStrictEqual(data, value))
        )
          throw new Error("schema-version-conflict");
      }
      tx.set(ref, value);
    });
  }
  async resolve(request: ResolveRequest): Promise<FormSchema | null> {
    // Single-field indexed query avoids requiring a deployed composite index.
    const snapshots = await this.db
      .collection("formSchemas")
      .where("pageFingerprints", "array-contains", request.pageFingerprint)
      .get();
    const matches: FormSchema[] = [];
    for (const doc of snapshots.docs) {
      const record: unknown = doc.data();
      try {
        validateStoredSchema(record);
      } catch {
        continue;
      }
      if (doc.id === record.schemaId && record.site === request.site && record.status === "active")
        matches.push(publicSchema(record));
    }
    matches.sort(
      (a, b) => b.version - a.version || b.confidence - a.confidence || a.schemaId.localeCompare(b.schemaId),
    );
    return matches[0] ?? null;
  }
}
