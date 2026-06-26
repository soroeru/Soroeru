// DomainService (RFC-002 §3): typed services over the Vault v2 record vault for
// the Soroeru domain. This layer owns semantic operations the UI/automation
// call through (later via Electron IPC), the most important of which for
// Slice A is Disclosure stale-state derivation (RFC-002 §4.2): comparing what a
// site holds against the user's canonical value so the ledger can flag "stale".
//
// Policy / Delegation Boundary decisions and Account Relationship filters are
// reshaped around later Issues; this foundation provides the storage-backed
// entity operations and stale-state logic they build on. Raw values are never
// logged here.

import { randomUUID } from "node:crypto";
import { normalizedValueHash } from "./normalize.js";
import {
  type AccountRelationship,
  type Credential,
  type Disclosure,
  type DisclosureSourceKind,
  type PersonalAttribute,
  type SiteAccount,
  type Sensitivity,
  type StaleState,
} from "./entities.js";
import { isSensitiveAttributeKey, MOST_SENSITIVE_ATTRIBUTE_KEY } from "./entities.js";
import type { VaultV2 } from "../store/vault-v2.js";

export interface SetPersonalAttributeInput {
  attributeKey: string;
  label: string;
  value: string;
  valueType?: PersonalAttribute["valueType"];
  sensitivity?: Sensitivity;
}

export interface UpsertSiteAccountInput {
  id?: string;
  domain: string;
  url?: string;
  displayName: string;
  relationshipSummary?: string;
}

export interface AddCredentialInput {
  siteAccountId: string;
  username: string;
  password: string;
  note?: string;
  source?: Credential["source"];
}

export interface AddDisclosureInput {
  siteAccountId: string;
  attributeKey: string;
  siteHeldValue?: string;
  observedAt?: number;
  sourcePageUrl?: string;
  sourceKind: DisclosureSourceKind;
  confidence?: number;
  evidenceIds?: string[];
}

export class DomainService {
  constructor(private readonly vault: VaultV2) {}

  /** Default sensitivity from the attribute key when the caller does not specify one. */
  private static defaultSensitivity(attributeKey: string): Sensitivity {
    if (attributeKey === MOST_SENSITIVE_ATTRIBUTE_KEY) return "most-sensitive";
    if (isSensitiveAttributeKey(attributeKey)) return "sensitive";
    return "normal";
  }

  // --- Personal Attributes (canonical values) ---

  /**
   * Upsert a canonical Personal Attribute. The attribute key is used as the
   * record id so a given attribute is canonical (one value per key). Changing a
   * value recomputes the stale-state of every Disclosure for that attribute.
   *
   * Invariant: any path that *changes which canonical value an attribute key
   * resolves to* must call `recomputeStaleStatesForAttribute`. A future
   * `deletePersonalAttribute` must route through that recompute so its
   * Disclosures revert to `unknown` rather than staying pinned at current/stale.
   */
  setPersonalAttribute(input: SetPersonalAttributeInput): PersonalAttribute {
    const attribute: PersonalAttribute = {
      id: input.attributeKey,
      attributeKey: input.attributeKey,
      label: input.label,
      value: input.value,
      valueType: input.valueType ?? "custom",
      sensitivity: input.sensitivity ?? DomainService.defaultSensitivity(input.attributeKey),
      updatedAt: Date.now(),
    };
    this.vault.put("personalAttribute", attribute);
    this.recomputeStaleStatesForAttribute(input.attributeKey);
    return attribute;
  }

  getPersonalAttribute(attributeKey: string): PersonalAttribute | undefined {
    return this.vault.get("personalAttribute", attributeKey);
  }

  listPersonalAttributes(): PersonalAttribute[] {
    return this.vault.list("personalAttribute");
  }

  // --- Site Accounts ---

  upsertSiteAccount(input: UpsertSiteAccountInput): SiteAccount {
    const id = input.id ?? randomUUID();
    const existing = this.vault.get("siteAccount", id);
    const account: SiteAccount = {
      id,
      domain: input.domain,
      displayName: input.displayName,
      createdAt: existing?.createdAt ?? Date.now(),
      updatedAt: Date.now(),
    };
    if (input.url !== undefined) account.url = input.url;
    if (input.relationshipSummary !== undefined) account.relationshipSummary = input.relationshipSummary;
    this.vault.put("siteAccount", account);
    return account;
  }

  getSiteAccount(id: string): SiteAccount | undefined {
    return this.vault.get("siteAccount", id);
  }

  listSiteAccounts(): SiteAccount[] {
    return this.vault.list("siteAccount");
  }

  // --- Credentials ---

  addCredential(input: AddCredentialInput): Credential {
    const credential: Credential = {
      id: randomUUID(),
      siteAccountId: input.siteAccountId,
      username: input.username,
      password: input.password,
      source: input.source ?? "user",
      updatedAt: Date.now(),
    };
    if (input.note !== undefined) credential.note = input.note;
    this.vault.put("credential", credential);
    return credential;
  }

  listCredentialsForSite(siteAccountId: string): Credential[] {
    return this.vault.list("credential").filter((c) => c.siteAccountId === siteAccountId);
  }

  // --- Disclosures (the ledger edge) ---

  /**
   * Record a Disclosure: a value a site holds for an attribute. The normalized
   * hash and stale-state are derived at insert time against the current
   * canonical attribute; both are recomputed whenever the attribute changes.
   */
  addDisclosure(input: AddDisclosureInput): Disclosure {
    const disclosure: Disclosure = {
      id: randomUUID(),
      siteAccountId: input.siteAccountId,
      attributeKey: input.attributeKey,
      observedAt: input.observedAt ?? Date.now(),
      sourceKind: input.sourceKind,
      confidence: input.confidence ?? 1,
      evidenceIds: input.evidenceIds ?? [],
      staleState: "unknown",
    };
    if (input.siteHeldValue !== undefined) {
      disclosure.siteHeldValue = input.siteHeldValue;
      disclosure.normalizedValueHash = normalizedValueHash(input.attributeKey, input.siteHeldValue);
    }
    if (input.sourcePageUrl !== undefined) disclosure.sourcePageUrl = input.sourcePageUrl;
    disclosure.staleState = this.deriveStaleState(disclosure);
    this.vault.put("disclosure", disclosure);
    return disclosure;
  }

  getDisclosure(id: string): Disclosure | undefined {
    return this.vault.get("disclosure", id);
  }

  listDisclosures(): Disclosure[] {
    return this.vault.list("disclosure");
  }

  listDisclosuresForSite(siteAccountId: string): Disclosure[] {
    return this.vault.list("disclosure").filter((d) => d.siteAccountId === siteAccountId);
  }

  listDisclosuresForAttribute(attributeKey: string): Disclosure[] {
    return this.vault.list("disclosure").filter((d) => d.attributeKey === attributeKey);
  }

  /**
   * Derive a Disclosure's stale-state (RFC-002 §4.2): compare its normalized
   * value hash with the canonical Personal Attribute's normalized hash.
   *
   * - `unknown` when the site-held value or the canonical attribute is missing;
   * - `current` when the normalized hashes match;
   * - `stale` otherwise.
   */
  deriveStaleState(disclosure: Pick<Disclosure, "attributeKey" | "normalizedValueHash">): StaleState {
    if (!disclosure.normalizedValueHash) return "unknown";
    const canonical = this.getPersonalAttribute(disclosure.attributeKey);
    if (!canonical) return "unknown";
    const canonicalHash = normalizedValueHash(canonical.attributeKey, canonical.value);
    return disclosure.normalizedValueHash === canonicalHash ? "current" : "stale";
  }

  /** Recompute and persist stale-state for every Disclosure. Returns the count that changed. */
  recomputeAllStaleStates(): number {
    let changed = 0;
    for (const disclosure of this.listDisclosures()) {
      const next = this.deriveStaleState(disclosure);
      if (next !== disclosure.staleState) {
        this.vault.put("disclosure", { ...disclosure, staleState: next });
        changed++;
      }
    }
    return changed;
  }

  private recomputeStaleStatesForAttribute(attributeKey: string): number {
    let changed = 0;
    for (const disclosure of this.listDisclosuresForAttribute(attributeKey)) {
      const next = this.deriveStaleState(disclosure);
      if (next !== disclosure.staleState) {
        this.vault.put("disclosure", { ...disclosure, staleState: next });
        changed++;
      }
    }
    return changed;
  }

  // --- Account Relationships (filters reshaped in #161) ---

  listAccountRelationships(): AccountRelationship[] {
    return this.vault.list("accountRelationship");
  }

  listAccountRelationshipsForSite(siteAccountId: string): AccountRelationship[] {
    return this.vault.list("accountRelationship").filter((r) => r.siteAccountId === siteAccountId);
  }
}
