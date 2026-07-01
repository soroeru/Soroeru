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
  type Constraint,
  type Credential,
  type Disclosure,
  type DisclosureSourceKind,
  type Evidence,
  type LocalDefinition,
  type PersonalAttribute,
  type SiteAccount,
  type Sensitivity,
  type StaleState,
  type WorkflowCheckpoint,
} from "./entities.js";
import { isSensitiveAttributeKey, MOST_SENSITIVE_ATTRIBUTE_KEY } from "./entities.js";
import type { VaultV2 } from "../store/vault-v2.js";
import type { ProfileKey } from "../types.js";

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
  normalizedValueHash?: string;
  observedAt?: number;
  sourcePageUrl?: string;
  sourceKind: DisclosureSourceKind;
  confidence?: number;
  evidenceIds?: string[];
}

export interface DynamicAttributeCandidateView {
  id: string;
  status: LocalDefinition["status"];
  label: string;
  proposedAttributeKey: ProfileKey;
  matchTerms: string[];
  fieldId?: string;
  sourcePageUrl?: string;
  /** The site the candidate was first observed on. Absent once confirmed (a
   * confirmed attribute is reusable across sites, so it is no longer tied to
   * the site that happened to surface it first). */
  siteAccountId?: string;
  createdAt: number;
  updatedAt: number;
}

export interface RecordDynamicAttributeCandidateInput {
  siteAccountId: string;
  label: string;
  fieldId: string;
  sourcePageUrl?: string;
  proposedAttributeKey: ProfileKey;
  matchTerms?: string[];
  now?: () => number;
}

export interface ConfirmDynamicAttributeCandidateInput {
  label: string;
  attributeKey: ProfileKey;
  matchTerms: string[];
  now?: () => number;
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
    const storedSiteHeldValue = disclosureStoredValue(input.attributeKey, input.siteHeldValue);
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
    if (storedSiteHeldValue !== undefined) {
      disclosure.siteHeldValue = storedSiteHeldValue;
      disclosure.normalizedValueHash = normalizedValueHash(input.attributeKey, storedSiteHeldValue);
    } else if (input.attributeKey !== MOST_SENSITIVE_ATTRIBUTE_KEY && input.normalizedValueHash !== undefined) {
      disclosure.normalizedValueHash = input.normalizedValueHash;
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
    const canonicalValue = comparisonValue(canonical.attributeKey, canonical.value);
    if (canonicalValue === undefined) return "unknown";
    const canonicalHash = normalizedValueHash(canonical.attributeKey, canonicalValue);
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

  addAccountRelationship(input: AddAccountRelationshipInput): AccountRelationship {
    const relationship: AccountRelationship = {
      id: randomUUID(),
      siteAccountId: input.siteAccountId,
      kind: input.kind,
      state: input.state,
      confidence: input.confidence ?? 1,
      evidenceIds: input.evidenceIds ?? [],
      observedAt: input.observedAt ?? Date.now(),
    };
    if (input.detail !== undefined) relationship.detail = input.detail;
    this.vault.put("accountRelationship", relationship);
    return relationship;
  }

  // --- Evidence (audit trail; never raw values) ---

  /**
   * Record a piece of audit Evidence. Callers must pass only redacted material
   * (URL, timestamp, field label/type, masked snippet, normalized hash). This
   * method does not accept and never stores raw values, screenshots, cookies,
   * or tokens (RFC-002 §5.1).
   */
  addEvidence(input: AddEvidenceInput): Evidence {
    const evidence: Evidence = {
      id: randomUUID(),
      observedAt: input.observedAt ?? Date.now(),
    };
    if (input.siteAccountId !== undefined) evidence.siteAccountId = input.siteAccountId;
    if (input.pageUrl !== undefined) evidence.pageUrl = input.pageUrl;
    if (input.fieldLabel !== undefined) evidence.fieldLabel = input.fieldLabel;
    if (input.fieldType !== undefined) evidence.fieldType = input.fieldType;
    if (input.maskedSnippet !== undefined) evidence.maskedSnippet = input.maskedSnippet;
    if (input.normalizedHash !== undefined) evidence.normalizedHash = input.normalizedHash;
    this.vault.put("evidence", evidence);
    return evidence;
  }

  listEvidence(): Evidence[] {
    return this.vault.list("evidence");
  }

  // --- Dynamic attribute candidates (user-confirmed schema growth) ---

  recordDynamicAttributeCandidate(input: RecordDynamicAttributeCandidateInput): DynamicAttributeCandidateView {
    const now = input.now ?? Date.now;
    const label = input.label.trim() || input.fieldId;
    const matchTerms = uniqueTerms(input.matchTerms ?? [label]);
    const id = dynamicAttributeDefinitionId(input.proposedAttributeKey);
    const existing = this.vault.get("localDefinition", id);
    const definition: LocalDefinition = {
      id,
      serviceName: label,
      source: "observation",
      status: existing?.status ?? "candidate",
      data: {
        kind: "dynamic-attribute",
        label,
        proposedAttributeKey: input.proposedAttributeKey,
        matchTerms,
        fieldId: input.fieldId,
        siteAccountId: input.siteAccountId,
        ...(input.sourcePageUrl !== undefined ? { sourcePageUrl: input.sourcePageUrl } : {}),
      },
      createdAt: existing?.createdAt ?? now(),
      updatedAt: now(),
    };
    this.vault.put("localDefinition", definition);
    return dynamicAttributeView(definition)!;
  }

  confirmDynamicAttributeCandidate(input: ConfirmDynamicAttributeCandidateInput): DynamicAttributeCandidateView {
    const now = input.now ?? Date.now;
    const label = input.label.trim() || input.attributeKey;
    const matchTerms = uniqueTerms(input.matchTerms.length > 0 ? input.matchTerms : [label]);
    const id = dynamicAttributeDefinitionId(input.attributeKey);
    const existing = this.vault.get("localDefinition", id);
    const definition: LocalDefinition = {
      id,
      serviceName: label,
      source: "user",
      status: "validated",
      data: {
        kind: "dynamic-attribute",
        label,
        proposedAttributeKey: input.attributeKey,
        attributeKey: input.attributeKey,
        matchTerms,
      },
      createdAt: existing?.createdAt ?? now(),
      updatedAt: now(),
    };
    this.vault.put("localDefinition", definition);
    return dynamicAttributeView(definition)!;
  }

  listDynamicAttributeCandidates(): DynamicAttributeCandidateView[] {
    return this.vault
      .list("localDefinition")
      .map(dynamicAttributeView)
      .filter((candidate): candidate is DynamicAttributeCandidateView => candidate !== undefined);
  }

  // --- Constraints (surfaced, never silently enforced) ---

  /** Surface a Constraint (e.g. a detected automation-prohibiting ToS clause). */
  addConstraint(input: AddConstraintInput): Constraint {
    const constraint: Constraint = {
      id: randomUUID(),
      kind: input.kind,
      detail: input.detail,
      evidenceIds: input.evidenceIds ?? [],
      observedAt: input.observedAt ?? Date.now(),
      resolution: input.resolution ?? "pending",
    };
    if (input.siteAccountId !== undefined) constraint.siteAccountId = input.siteAccountId;
    this.vault.put("constraint", constraint);
    return constraint;
  }

  listConstraints(): Constraint[] {
    return this.vault.list("constraint");
  }

  // --- Workflow checkpoints (encrypted resume state, RFC-002 §5.2) ---

  /**
   * Insert or update the checkpoint for a (workflow, siteAccount) pair. The id
   * is derived so a run resumes from one record per site rather than appending.
   */
  saveCheckpoint(input: SaveCheckpointInput): WorkflowCheckpoint {
    const id = checkpointId(input.workflow, input.siteAccountId);
    const checkpoint: WorkflowCheckpoint = {
      id,
      workflow: input.workflow,
      step: input.step,
      status: input.status,
      updatedAt: Date.now(),
    };
    if (input.siteAccountId !== undefined) checkpoint.siteAccountId = input.siteAccountId;
    if (input.resumeData !== undefined) checkpoint.resumeData = input.resumeData;
    this.vault.put("workflowCheckpoint", checkpoint);
    return checkpoint;
  }

  getCheckpoint(workflow: WorkflowCheckpoint["workflow"], siteAccountId?: string): WorkflowCheckpoint | undefined {
    return this.vault.get("workflowCheckpoint", checkpointId(workflow, siteAccountId));
  }

  listCheckpoints(): WorkflowCheckpoint[] {
    return this.vault.list("workflowCheckpoint");
  }
}

export interface AddAccountRelationshipInput {
  siteAccountId: string;
  kind: AccountRelationship["kind"];
  state: AccountRelationship["state"];
  confidence?: number;
  evidenceIds?: string[];
  observedAt?: number;
  detail?: string;
}

export interface AddEvidenceInput {
  siteAccountId?: string;
  pageUrl?: string;
  observedAt?: number;
  fieldLabel?: string;
  fieldType?: string;
  maskedSnippet?: string;
  normalizedHash?: string;
}

export interface AddConstraintInput {
  siteAccountId?: string;
  kind: Constraint["kind"];
  detail: string;
  evidenceIds?: string[];
  observedAt?: number;
  resolution?: Constraint["resolution"];
}

export interface SaveCheckpointInput {
  workflow: WorkflowCheckpoint["workflow"];
  siteAccountId?: string;
  step: string;
  status: WorkflowCheckpoint["status"];
  resumeData?: Record<string, string | number | boolean>;
}

function checkpointId(workflow: string, siteAccountId?: string): string {
  return siteAccountId ? `${workflow}:${siteAccountId}` : workflow;
}

function disclosureStoredValue(attributeKey: string, value: string | undefined): string | undefined {
  if (attributeKey === MOST_SENSITIVE_ATTRIBUTE_KEY) return undefined;
  if (value === undefined) return undefined;
  return comparisonValue(attributeKey, value);
}

function comparisonValue(attributeKey: string, value: string): string | undefined {
  if (attributeKey === MOST_SENSITIVE_ATTRIBUTE_KEY) return undefined;
  if (attributeKey === "card.number") {
    const digits = value.replace(/\D/g, "");
    return digits.slice(-4);
  }
  return value;
}

function dynamicAttributeDefinitionId(attributeKey: string): string {
  return `dynamic-attribute:${attributeKey}`;
}

function dynamicAttributeView(definition: LocalDefinition): DynamicAttributeCandidateView | undefined {
  const data = definition.data;
  if (data["kind"] !== "dynamic-attribute") return undefined;
  const label = stringData(data["label"]);
  const proposedAttributeKey = stringData(data["attributeKey"]) ?? stringData(data["proposedAttributeKey"]);
  if (!label || !proposedAttributeKey || !proposedAttributeKey.startsWith("custom.")) return undefined;
  const matchTerms = Array.isArray(data["matchTerms"])
    ? data["matchTerms"].filter((term): term is string => typeof term === "string" && term.trim() !== "")
    : [label];
  const view: DynamicAttributeCandidateView = {
    id: definition.id,
    status: definition.status,
    label,
    proposedAttributeKey: proposedAttributeKey as ProfileKey,
    matchTerms: uniqueTerms(matchTerms),
    createdAt: definition.createdAt,
    updatedAt: definition.updatedAt,
  };
  const fieldId = stringData(data["fieldId"]);
  if (fieldId !== undefined) view.fieldId = fieldId;
  const sourcePageUrl = stringData(data["sourcePageUrl"]);
  if (sourcePageUrl !== undefined) view.sourcePageUrl = sourcePageUrl;
  const siteAccountId = stringData(data["siteAccountId"]);
  if (siteAccountId !== undefined) view.siteAccountId = siteAccountId;
  return view;
}

function stringData(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
}

function uniqueTerms(terms: string[]): string[] {
  return [...new Set(terms.map((term) => term.trim()).filter((term) => term !== ""))];
}
