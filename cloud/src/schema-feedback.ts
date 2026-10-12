import { createHmac, createHash } from "node:crypto";
import { Firestore } from "@google-cloud/firestore";
import { type FeedbackRequest } from "../../src/shared/cloud-contract.js";
import { validateStoredSchema, type StoredFormSchema } from "./schema-registry.js";

export const LIFECYCLE = {
  MIN_VALIDATIONS: 5,
  MIN_DISTINCT_VALIDATORS: 3,
  WINDOW: 10,
  PROMOTE_SUCCESS_RATE: 0.9,
  RETIRE_FAILURE_RATE: 0.3,
  MAX_FAILURES_TO_PROMOTE: 3,
  CANDIDATE_TTL_DAYS: 30,
} as const;

// Same high-risk attribute key pattern as validateFormSchema in cloud-contract.ts.
const HIGH_RISK_ATTR = /^(?:name\.|address\.|postal\.|birth\.|card\.)/;

function hasHighRiskFields(schema: StoredFormSchema): boolean {
  return schema.fields.some((f) => HIGH_RISK_ATTR.test(f.attributeKey));
}

function sortedMappingKey(mappings: { anchor: string; attributeKey: string }[]): string {
  return JSON.stringify(
    [...mappings]
      .sort((a, b) => a.anchor.localeCompare(b.anchor))
      .map((m) => ({ anchor: m.anchor, attributeKey: m.attributeKey })),
  );
}

function sha256hex(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

type RecentEntry = { outcome: "validated" | "failed"; at: string };

export function evaluateLifecycle(
  schema: StoredFormSchema,
  newValidationCount: number,
  newDistinctValidators: number,
  newFailureCount: number,
  ringBuffer: ("validated" | "failed")[],
  now: Date,
): "candidate" | "active" | "retired" {
  if (schema.status === "retired") return "retired";

  // Under MIN_VALIDATIONS: only TTL retirement applies for candidates.
  if (newValidationCount < LIFECYCLE.MIN_VALIDATIONS) {
    if (schema.status === "candidate") {
      const ageDays = (now.getTime() - Date.parse(schema.createdAt)) / 86400000;
      if (ageDays >= LIFECYCLE.CANDIDATE_TTL_DAYS) return "retired";
    }
    return schema.status;
  }

  // Failure-rate retirement applies to both candidate and active.
  if (ringBuffer.length > 0) {
    const recentFails = ringBuffer.filter((o) => o === "failed").length;
    if (recentFails / ringBuffer.length > LIFECYCLE.RETIRE_FAILURE_RATE) return "retired";
  }

  if (schema.status === "candidate") {
    const successCount = ringBuffer.filter((o) => o === "validated").length;
    const successRate = ringBuffer.length > 0 ? successCount / ringBuffer.length : 0;
    const canPromote =
      newDistinctValidators >= LIFECYCLE.MIN_DISTINCT_VALIDATORS &&
      newFailureCount < LIFECYCLE.MAX_FAILURES_TO_PROMOTE &&
      successRate >= LIFECYCLE.PROMOTE_SUCCESS_RATE;

    const ageDays = (now.getTime() - Date.parse(schema.createdAt)) / 86400000;
    const pastTtl = ageDays >= LIFECYCLE.CANDIDATE_TTL_DAYS;

    if (pastTtl && !canPromote) return "retired";
    if (canPromote) {
      // High-risk fields only reach active via official seeds, not auto-promotion.
      if (hasHighRiskFields(schema)) return "candidate";
      return "active";
    }
  }

  return schema.status;
}

export class SchemaFeedbackHandler {
  private readonly db: Firestore;
  constructor(
    private readonly serverSecret: string,
    db?: Firestore,
    private readonly now = (): Date => new Date(),
  ) {
    this.db = db ?? new Firestore();
  }

  private computeValidatorHmac(siteValidatorToken: string): string {
    return createHmac("sha256", Buffer.from(this.serverSecret, "hex"))
      .update(Buffer.from(siteValidatorToken, "hex"))
      .digest("hex");
  }

  private async findOrCreateCandidate(req: FeedbackRequest, now: Date): Promise<string | null> {
    const snapshots = await this.db
      .collection("formSchemas")
      .where("pageFingerprints", "array-contains", req.pageFingerprint)
      .get();

    const reqMappingKey = sortedMappingKey(req.mappings);
    for (const doc of snapshots.docs) {
      const data: unknown = doc.data();
      try {
        validateStoredSchema(data);
      } catch {
        continue;
      }
      const schema = data as StoredFormSchema;
      if (schema.site !== req.site || schema.status !== "candidate") continue;
      const schemaMappingKey = sortedMappingKey(
        schema.fields.map((f) => ({ anchor: f.anchor, attributeKey: f.attributeKey })),
      );
      if (schemaMappingKey === reqMappingKey) return schema.schemaId;
    }

    const formKey = sha256hex(`${req.site}:${req.pagePurpose}:${req.pageFingerprint}`);
    const schemaId = sha256hex(
      `candidate:${req.site}:${req.pagePurpose}:${req.pageFingerprint}:${reqMappingKey}`,
    );
    const nowStr = now.toISOString();
    const newSchema: StoredFormSchema = {
      schemaId,
      site: req.site,
      formKey,
      version: 1,
      pageFingerprints: [req.pageFingerprint],
      fields: req.mappings.map((m) => ({
        anchor: m.anchor,
        attributeKey: m.attributeKey,
        required: false,
      })),
      confidence: 0.5,
      status: "candidate",
      provenance: "gemini_structure",
      validationCount: 0,
      distinctValidators: 0,
      failureCount: 0,
      createdAt: nowStr,
      updatedAt: nowStr,
    };

    try {
      validateStoredSchema(newSchema);
    } catch {
      return null;
    }

    const ref = this.db.collection("formSchemas").doc(schemaId);
    await this.db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      if (!snap.exists) tx.set(ref, newSchema);
    });
    return schemaId;
  }

  async process(req: FeedbackRequest): Promise<{ accepted: boolean }> {
    const now = this.now();

    let schemaId = req.schemaId;
    if (schemaId === null) {
      schemaId = await this.findOrCreateCandidate(req, now);
      if (!schemaId) return { accepted: false };
    }

    const hmac = this.computeValidatorHmac(req.siteValidatorToken);
    const nowStr = now.toISOString();

    const schemaRef = this.db.collection("formSchemas").doc(schemaId);
    const feedbackBase = this.db.collection("schemaFeedback").doc(schemaId);
    const validatorRef = feedbackBase.collection("validators").doc(hmac);
    const receiptRef = feedbackBase.collection("receipts").doc(req.idempotencyKey);
    const recentRefs = Array.from({ length: LIFECYCLE.WINDOW }, (_, i) =>
      feedbackBase.collection("recent").doc(String(i)),
    );

    let accepted = false;
    try {
      await this.db.runTransaction(async (tx) => {
        const schemaSnap = await tx.get(schemaRef);
        if (!schemaSnap.exists) throw new Error("schema-not-found");
        const schemaData: unknown = schemaSnap.data();
        validateStoredSchema(schemaData);
        const schema = schemaData as StoredFormSchema;
        if (schema.status === "retired") throw new Error("schema-retired");

        // Receipt-based idempotency: any prior delivery with this exact key is accepted without
        // re-counting. This prevents A→B→A re-send double-counting that the last-key comparison
        // could not prevent.
        const receiptSnap = await tx.get(receiptRef);
        if (receiptSnap.exists) {
          accepted = true;
          return;
        }

        const validatorSnap = await tx.get(validatorRef);
        const validatorData = validatorSnap.exists
          ? (validatorSnap.data() as {
              outcome: "validated" | "failed";
              idempotencyKey: string;
            })
          : null;

        const recentSnaps = await Promise.all(recentRefs.map((r) => tx.get(r)));

        const isNewValidator = !validatorData;
        const wasValidated = validatorData?.outcome === "validated";
        const wasFailed = validatorData?.outcome === "failed";

        const newValidationCount = schema.validationCount + 1;
        let newDistinctValidators = schema.distinctValidators;
        let newFailureCount = schema.failureCount;

        if (req.outcome === "validated") {
          if (isNewValidator || wasFailed) newDistinctValidators++;
        } else {
          newFailureCount++;
          if (wasValidated) newDistinctValidators = Math.max(0, newDistinctValidators - 1);
        }

        const slot = schema.validationCount % LIFECYCLE.WINDOW;
        // recentRefs is always length LIFECYCLE.WINDOW, slot is always in bounds.
        tx.set(recentRefs[slot]!, { outcome: req.outcome, at: nowStr });

        // Ring buffer state after this write.
        const ringBuffer = recentSnaps
          .map((s, i): "validated" | "failed" | null => {
            if (i === slot) return req.outcome;
            return s.exists ? (s.data() as RecentEntry).outcome : null;
          })
          .filter((o): o is "validated" | "failed" => o !== null);

        const newStatus = evaluateLifecycle(
          schema,
          newValidationCount,
          newDistinctValidators,
          newFailureCount,
          ringBuffer,
          now,
        );

        // On promotion: bump version so resolve picks this over older actives.
        const newVersion =
          newStatus === "active" && schema.status !== "active" ? schema.version + 1 : schema.version;

        const updated: StoredFormSchema = {
          ...schema,
          validationCount: newValidationCount,
          distinctValidators: newDistinctValidators,
          failureCount: newFailureCount,
          status: newStatus,
          version: newVersion,
          updatedAt: nowStr,
        };
        // Re-validate before writing (catches high-risk field / active provenance conflicts).
        validateStoredSchema(updated);

        tx.set(validatorRef, {
          outcome: req.outcome,
          idempotencyKey: req.idempotencyKey,
          updatedAt: nowStr,
        });
        // Write receipt so any re-delivery of this idempotencyKey is a no-op.
        tx.set(receiptRef, { at: nowStr });
        tx.set(schemaRef, updated);

        // Retire the previous active schema for the same formKey if we just promoted.
        // Queries are not allowed inside transactions; the caller (retireOldActive) handles this.
        accepted = true;
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : "";
      if (msg === "schema-not-found" || msg === "schema-retired") return { accepted: false };
      throw err;
    }

    // Post-promotion: retire old active schema for the same formKey outside the transaction.
    if (accepted) await this.retireOldActive(schemaId, nowStr);

    return { accepted };
  }

  private async retireOldActive(promotedId: string, nowStr: string): Promise<void> {
    const promotedSnap = await this.db.collection("formSchemas").doc(promotedId).get();
    if (!promotedSnap.exists) return;
    const promoted: unknown = promotedSnap.data();
    try {
      validateStoredSchema(promoted);
    } catch {
      return;
    }
    const schema = promoted as StoredFormSchema;
    if (schema.status !== "active") return;

    const snaps = await this.db
      .collection("formSchemas")
      .where("formKey", "==", schema.formKey)
      .where("status", "==", "active")
      .get();

    const batch = this.db.batch();
    for (const doc of snaps.docs) {
      if (doc.id === promotedId) continue;
      const old: unknown = doc.data();
      try {
        validateStoredSchema(old);
      } catch {
        continue;
      }
      const oldSchema = old as StoredFormSchema;
      if (oldSchema.version < schema.version) {
        batch.set(doc.ref, { ...oldSchema, status: "retired", updatedAt: nowStr });
      }
    }
    await batch.commit();
  }
}

/**
 * Scan all formSchemas for personal-value patterns (§9 detection job).
 * Flags and retires any document that fails closed-schema validation.
 */
export async function runDetectionJob(
  db: Firestore,
  log: (msg: string) => void,
): Promise<{ scanned: number; flagged: number }> {
  const snapshots = await db.collection("formSchemas").get();
  let scanned = 0;
  let flagged = 0;
  const nowStr = new Date().toISOString();

  for (const doc of snapshots.docs) {
    scanned++;
    const data: unknown = doc.data();
    let valid = true;
    try {
      validateStoredSchema(data);
    } catch {
      valid = false;
    }
    if (!valid) {
      flagged++;
      log(`pii-scan-flag schemaId=${doc.id}`);
      await db.runTransaction(async (tx) => {
        const snap = await tx.get(doc.ref);
        if (!snap.exists) return;
        const schema: unknown = snap.data();
        if (
          schema !== null &&
          typeof schema === "object" &&
          !Array.isArray(schema) &&
          "status" in schema &&
          (schema as { status: unknown }).status !== "retired"
        ) {
          tx.set(doc.ref, {
            ...(schema as Record<string, unknown>),
            status: "retired",
            updatedAt: nowStr,
          });
        }
      });
    }
  }

  return { scanned, flagged };
}
