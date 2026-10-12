import {
  validateCloudRequest,
  validateCloudResponse,
  validateFormSchema,
  validateStructureMappings,
  type FormSchema,
  type CloudRequests,
  type CloudResponses,
} from "../src/shared/cloud-contract.js";
import type { VaultSession } from "../src/store/vault-session.js";
import type { PageCommand } from "../src/shared/extension-messages.js";
import { validateSchemaReadResult, type SchemaReadResult } from "../src/shared/schema-resolution.js";
import { deliverQueue, type DeliveryClient } from "./cloud-delivery-queue.js";

/** 30-day cache freshness window (§567 §2.2). */
const CACHE_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

export interface ResolveClient {
  call<K extends "resolve" | "mapStructure">(
    operation: K,
    request: CloudRequests[K],
  ): Promise<CloudResponses[K]>;
}
/** Side Panel Tier 1 seam. Values stay on the direct content->panel path and in the encrypted vault. */
export class ResolutionOrchestrator {
  constructor(
    private readonly options: {
      session: VaultSession;
      client?: ResolveClient;
      /** Separate delivery client for queue flushing; may be the same CloudClient instance. */
      deliveryClient?: DeliveryClient;
      clientVersion: string;
      sendPageCommand: (command: PageCommand) => Promise<unknown>;
      isActive: () => boolean;
    },
  ) {}
  async resolve(
    site: string,
  ): Promise<(SchemaReadResult & { schema: FormSchema; source: "cloud" | "cache" | "gemini" }) | null> {
    let reachable = false;
    const tier1 = await this.resolveTier1(site, () => {
      reachable = true;
    });
    const o = this.options;
    const active = () => {
      if (o.session.state !== "unlocked" || !o.isActive()) throw new Error("resolution-inactive");
    };
    active();
    if (
      !reachable ||
      !o.client ||
      !o.session.vault.get("cloudSettings", "cloud")?.cloudAssistEnabled ||
      (tier1 && tier1.unresolved.length === 0)
    )
      return tier1;
    let snapshotReady = false;
    let localReadStarted = false;
    try {
      const snapshot = await o.sendPageCommand({ command: "structureSnapshot", site });
      validateCloudRequest("mapStructure", snapshot);
      active();
      if (
        snapshot.site !== site ||
        (tier1 && !tier1.schema.pageFingerprints.includes(snapshot.pageFingerprint))
      )
        throw new Error("stale-structure-page");
      const resolvedKeys = new Set(tier1?.values.map((v) => v.attributeKey));
      const resolvedIds = new Set(tier1?.values.map((v) => v.itemId));
      snapshot.items = snapshot.items.filter((i) => !resolvedIds.has(i.id));
      if (!snapshot.items.length) return tier1;
      snapshotReady = true;
      const response = await o.client.call("mapStructure", snapshot);
      validateStructureMappings(snapshot, response);
      active();
      const fields = response.mappings
        .filter((m) => m.confidence >= 0.8 && !resolvedKeys.has(m.attributeKey))
        .map((m) => ({ anchor: m.itemId, attributeKey: m.attributeKey, required: true }));
      if (!fields.length) return tier1;
      // This ephemeral candidate grants no authority and is never cached or shared as active.
      // readSchema applies the identical live-page/classifier/wall checks as Tier 1.
      const schema: FormSchema = {
        schemaId: snapshot.pageFingerprint,
        site,
        formKey: snapshot.pageFingerprint,
        version: 1,
        pageFingerprints: [snapshot.pageFingerprint],
        fields,
        confidence: 0.8,
        status: "candidate",
        provenance: "gemini_structure",
      };
      localReadStarted = true;
      const local = await o.sendPageCommand({ command: "readSchema", schema });
      validateSchemaReadResult(local, schema);
      active();
      const accepted = local.values.map((v) => ({ anchor: v.itemId, attributeKey: v.attributeKey }));
      const settings = o.session.vault.get("cloudSettings", "cloud");
      if (accepted.length && settings?.cloudAssistEnabled && settings.telemetryEnabled) {
        const key = await crypto.subtle.importKey(
          "raw",
          new TextEncoder().encode(settings.validatorKey),
          { name: "HMAC", hash: "SHA-256" },
          false,
          ["sign"],
        );
        const token = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(site)));
        const siteValidatorToken = Array.from(token, (b) => b.toString(16).padStart(2, "0")).join("");
        active();
        // Re-read preferences after async work so an off switch takes effect immediately.
        const current = o.session.vault.get("cloudSettings", "cloud");
        if (current?.telemetryEnabled && current.cloudAssistEnabled) {
          const body: CloudRequests["feedback"] = {
            schemaId: null,
            site,
            pageFingerprint: snapshot.pageFingerprint,
            pagePurpose: response.pagePurpose,
            mappings: accepted,
            outcome: "validated",
            resolutionTier: "gemini_structure",
            siteValidatorToken,
            idempotencyKey: crypto.randomUUID(),
          };
          validateCloudRequest("feedback", body);
          o.session.vault.put("cloudSettings", {
            ...current,
            queue: [
              ...current.queue,
              {
                idempotencyKey: body.idempotencyKey,
                kind: "feedback" as const,
                body: { ...body },
                attempts: 0,
                enqueuedAt: Date.now(),
              },
            ].slice(-100),
            updatedAt: Date.now(),
          });
          await o.session.save();
          active();
        }
      }
      const replaced = new Set(local.values.map((v) => v.attributeKey));
      const attempted = new Set(fields.map((f) => f.attributeKey));
      return {
        values: [...(tier1?.values ?? []), ...local.values],
        unresolved: [
          ...(tier1?.unresolved ?? []).filter(
            (v) => !replaced.has(v.attributeKey) && !attempted.has(v.attributeKey),
          ),
          ...local.unresolved,
        ],
        schema: {
          ...schema,
          fields: [
            ...(tier1?.schema.fields ?? []).filter((f) => !attempted.has(f.attributeKey)),
            ...schema.fields,
          ],
        },
        source: "gemini",
      };
    } catch {
      active();
      // Invalid proposals/outages never trigger a Tier 3 disclosure or retry.
      return snapshotReady && !localReadStarted ? tier1 : null;
    }
  }
  private async resolveTier1(
    site: string,
    reachable: () => void,
  ): Promise<(SchemaReadResult & { schema: FormSchema; source: "cloud" | "cache" }) | null> {
    const o = this.options;
    if (o.session.state !== "unlocked" || !o.isActive()) throw new Error("resolution-inactive");
    const print = await o.sendPageCommand({ command: "schemaFingerprint" });
    const request = { site, pageFingerprint: print, clientVersion: o.clientVersion };
    validateCloudRequest("resolve", request);
    const vault = o.session.vault;
    const settings = vault.get("cloudSettings", "cloud");
    let schema: FormSchema | null = null;
    let source: "cloud" | "cache" = "cache";
    if (settings?.cloudAssistEnabled && o.client) {
      try {
        const response = await o.client.call("resolve", request);
        validateCloudResponse("resolve", response);
        reachable();
        schema = response.schema;
        source = "cloud";
        // Fire-and-forget: flush queued feedback/outcome items now that we know we're online.
        if (o.deliveryClient) {
          deliverQueue(o.session, o.deliveryClient).catch(() => {
            /* Queue delivery errors are non-fatal; the queue persists for the next attempt. */
          });
        }
      } catch {
        /* No retries. Offline falls back to encrypted cached structure. */
      }
    }
    if (o.session.state !== "unlocked" || !o.isActive()) throw new Error("resolution-inactive");
    if (!schema && source === "cache") {
      const now = Date.now();
      const matches: FormSchema[] = [];
      for (const entry of vault.list("formSchemaCache")) {
        try {
          // Stale cache entries (older than 30 days) are ignored.
          if (now - entry.fetchedAt > CACHE_MAX_AGE_MS) continue;
          validateFormSchema(entry.schema);
          if (
            entry.schema.site === site &&
            entry.schema.status === "active" &&
            entry.schema.pageFingerprints.includes(request.pageFingerprint)
          )
            matches.push(entry.schema);
        } catch {
          /* Corrupt or obsolete cache entries never authorize reads. */
        }
      }
      matches.sort((a, b) => b.version - a.version || b.confidence - a.confidence);
      schema = matches[0] ?? null;
    }
    if (!schema) return null;
    validateFormSchema(schema);
    if (
      schema.status !== "active" ||
      schema.site !== site ||
      !schema.pageFingerprints.includes(request.pageFingerprint) ||
      schema.confidence < 0.8
    )
      return null;
    // The content script rescans, checks walls/fingerprint, and corroborates each anchor before reading.
    const result = await o.sendPageCommand({ command: "readSchema", schema });
    validateSchemaReadResult(result, schema);
    if (o.session.state !== "unlocked" || !o.isActive()) throw new Error("resolution-inactive");
    if (source === "cloud") {
      vault.put("formSchemaCache", {
        id: schema.schemaId,
        site,
        schemaId: schema.schemaId,
        version: schema.version,
        schema: { ...schema },
        fetchedAt: Date.now(),
      });
      await o.session.save();
    }
    return { ...result, schema, source };
  }
}
