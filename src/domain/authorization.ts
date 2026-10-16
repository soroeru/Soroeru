import type { Capability, CapabilityScope, PersonalAttribute } from "./entities.js";

export const AUTHORIZATION_POLICY_VERSION = 1;
export type Operation = Capability["operationType"];
export const OPERATIONS: readonly Operation[] = ["collection", "ai-assisted-discovery", "update", "withdrawal", "registration"];
const record = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const time = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v >= 0;
const strings = (v: unknown): v is string[] => Array.isArray(v) && v.length > 0 && v.length <= 10000 && v.every((x, i) => typeof x === "string" && x.length > 0 && x.length <= 256 && (i === 0 || (v[i - 1] as string) < x));
export function isCapability(value: unknown): value is Capability {
  if (!record(value) || typeof value.id !== "string" || !OPERATIONS.includes(value.operationType as Operation) ||
      !Number.isSafeInteger(value.revision) || (value.revision as number) < 0 || !time(value.updatedAt) ||
      (value.reducedAt !== undefined && !time(value.reducedAt)) || "understandingCheckPassedAt" in value) return false;
  if (value.level === "L0") return value.scope === undefined && value.policyVersion === undefined && value.explicitlyEnabledAt === undefined;
  return value.level === "L1" && value.policyVersion === AUTHORIZATION_POLICY_VERSION && time(value.explicitlyEnabledAt) &&
    record(value.scope) && strings(value.scope.siteAccountIds) && strings(value.scope.attributeKeys);
}
export function isPersonalAttribute(value: unknown): value is PersonalAttribute {
  if (!record(value) || typeof value.id !== "string" || typeof value.attributeKey !== "string" || typeof value.label !== "string" ||
      typeof value.value !== "string" || !time(value.updatedAt) || !["normal", "sensitive", "most-sensitive"].includes(value.sensitivity as string) ||
      !["text", "email", "phone", "postal", "address", "name", "card", "date", "secret", "custom"].includes(value.valueType as string)) return false;
  const p = value.provenance;
  if (!record(p)) return false;
  if (p.verification === "unverified") return (p.source === "user-entered" || p.source === "legacy-unknown") && Object.keys(p).length === 2;
  return p.verification === "verified" && p.source === "identity-verification" && p.method === "jpki" && time(p.verifiedAt) && typeof p.evidenceId === "string" && p.evidenceId.length > 0;
}
export function normalizeScope(scope: CapabilityScope): CapabilityScope {
  return { siteAccountIds: [...new Set(scope.siteAccountIds)].sort(), attributeKeys: [...new Set(scope.attributeKeys)].sort() };
}
export function scopeContains(outer: CapabilityScope, inner: CapabilityScope): boolean {
  return inner.siteAccountIds.every(id => outer.siteAccountIds.includes(id)) && inner.attributeKeys.every(key => outer.attributeKeys.includes(key));
}
export function intersectScope(a: CapabilityScope, b: CapabilityScope): CapabilityScope {
  return normalizeScope({ siteAccountIds: a.siteAccountIds.filter(id => b.siteAccountIds.includes(id)), attributeKeys: a.attributeKeys.filter(key => b.attributeKeys.includes(key)) });
}
export interface OperationContext {
  operation: Operation;
  siteAccountId: string;
  attributeKeys: string[];
  actionId: string;
  revision: number;
  policyVersion: number;
}
export type AuthorizationDecision = { kind: "permitted" } | { kind: "review-required" } | { kind: "stopped"; reason: "stale" | "outside-scope" };
export function authorize(capability: Capability | undefined, context: OperationContext): AuthorizationDecision {
  if (!context.actionId || context.policyVersion !== AUTHORIZATION_POLICY_VERSION || context.revision !== (capability?.revision ?? 0)) return { kind: "stopped", reason: "stale" };
  if (!capability || capability.level === "L0") return { kind: "review-required" };
  if (!isCapability(capability) || capability.operationType !== context.operation || !scopeContains(capability.scope!, { siteAccountIds: [context.siteAccountId], attributeKeys: context.attributeKeys })) return { kind: "stopped", reason: "outside-scope" };
  return { kind: "permitted" };
}
