import { AUTHORIZATION_POLICY_VERSION, type Operation } from "./authorization.js";

export interface ApprovalIdentity {
  actionId: string;
  operation: Operation;
  targetIds: string[];
  scopeRevision: number;
  policyVersion: number;
  consequenceDigest: string;
}
export interface ApprovalEvent extends ApprovalIdentity {
  observedAt: number;
  outcome: "approved" | "declined";
}
export async function consequenceDigest(consequence: unknown): Promise<string> {
  const bytes = await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(consequence)));
  return Array.from(new Uint8Array(bytes), b => b.toString(16).padStart(2, "0")).join("");
}

/** Memory-only, action-local decisions; evidence is committed before returning permission. */
export class ConsequenceApprovals<T extends { approved: boolean }> {
  private readonly approvals = new Map<string, T>();
  private epoch = 0;
  constructor(private readonly actionId: string, private readonly persist: (event: ApprovalEvent) => Promise<void>) {}
  interrupt(): void { this.epoch++; this.approvals.clear(); }
  async decide(identity: ApprovalIdentity, prompt: () => Promise<T>, individualDecision = false): Promise<T> {
    if (identity.actionId !== this.actionId || !identity.targetIds.length || identity.policyVersion !== AUTHORIZATION_POLICY_VERSION ||
        !Number.isSafeInteger(identity.scopeRevision) || identity.scopeRevision < 0 || !/^[a-f0-9]{64}$/.test(identity.consequenceDigest)) throw new Error("consequence requires review");
    const key = JSON.stringify({ ...identity, targetIds: [...new Set(identity.targetIds)].sort() });
    const cached = individualDecision ? undefined : this.approvals.get(key);
    if (cached) return structuredClone(cached);
    const epoch = this.epoch;
    const decision = await prompt();
    if (epoch !== this.epoch) throw new Error("approval interrupted");
    await this.persist({ ...identity, observedAt: Date.now(), outcome: decision.approved ? "approved" : "declined" });
    if (epoch !== this.epoch) throw new Error("approval interrupted");
    if (decision.approved && !individualDecision) this.approvals.set(key, structuredClone(decision));
    return decision;
  }
}
