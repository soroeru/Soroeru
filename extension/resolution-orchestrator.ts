import {
  validateCloudRequest,
  validateCloudResponse,
  validateFormSchema,
  type FormSchema,
  type CloudRequests,
  type CloudResponses,
} from "../src/shared/cloud-contract.js";
import type { VaultSession } from "../src/store/vault-session.js";
import type { PageCommand } from "../src/shared/extension-messages.js";
import { validateSchemaReadResult, type SchemaReadResult } from "../src/shared/schema-resolution.js";

export interface ResolveClient {
  call(operation: "resolve", request: CloudRequests["resolve"]): Promise<CloudResponses["resolve"]>;
}
/** Side Panel Tier 1 seam. Values stay on the direct content->panel path and in the encrypted vault. */
export class ResolutionOrchestrator {
  constructor(
    private readonly options: {
      session: VaultSession;
      client?: ResolveClient;
      clientVersion: string;
      sendPageCommand: (command: PageCommand) => Promise<unknown>;
      isActive: () => boolean;
    },
  ) {}
  async resolve(
    site: string,
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
        schema = response.schema;
        source = "cloud";
      } catch {
        /* No retries. Offline falls back to encrypted cached structure. */
      }
    }
    if (o.session.state !== "unlocked" || !o.isActive()) throw new Error("resolution-inactive");
    if (!schema && source === "cache") {
      const matches: FormSchema[] = [];
      for (const entry of vault.list("formSchemaCache")) {
        try {
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
