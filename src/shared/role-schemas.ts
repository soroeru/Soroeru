/**
 * Role-specific context schemas for isolated agents (Issue #441).
 *
 * Enforces role input/output isolation so subagents/workers receive only
 * the structured context required for their specific role without exposing
 * internal prompts, unparsed raw model responses, chain-of-thought, or
 * unneeded conversation history.
 */

export interface SharedFacts {
  readonly issueNumber: number;
  readonly acceptanceCriteria: readonly string[];
  readonly repositoryRules: readonly string[];
  readonly gitState: {
    readonly branch: string;
    readonly commitHash: string;
    readonly dirty: boolean;
    readonly upstream?: string;
  };
}

export interface PlannerInput {
  readonly sharedFacts: SharedFacts;
  readonly issueTitle: string;
  readonly issueBody: string;
  readonly targetFiles?: readonly string[];
}

export interface PlannerOutput {
  readonly planSummary: string;
  readonly proposedSteps: readonly string[];
  readonly estimatedRisk?: "low" | "medium" | "high";
  readonly artifactReferences: readonly string[];
}

export interface AnalystInput {
  readonly sharedFacts: SharedFacts;
  readonly planSummary: string;
  readonly targetFiles: readonly string[];
  readonly focusAreas?: readonly string[];
}

export interface AnalystOutput {
  readonly analysisFindings: readonly string[];
  readonly potentialRisks: readonly string[];
  readonly artifactReferences: readonly string[];
}

export interface ImplementerInput {
  readonly sharedFacts: SharedFacts;
  readonly planSummary: string;
  readonly analysisFindings: readonly string[];
  readonly targetFiles: readonly string[];
}

export interface ImplementerOutput {
  readonly changedFiles: readonly string[];
  readonly summaryOfChanges: string;
  readonly artifactReferences: readonly string[];
}

export interface ReviewerInput {
  readonly acceptanceCriteria: readonly string[];
  readonly diffReference: string;
  readonly changedFiles: readonly string[];
  readonly testSummary: {
    readonly passed: boolean;
    readonly totalTests: number;
    readonly failedTests: number;
    readonly coverageSummary?: string;
  };
}

export interface ReviewerOutput {
  readonly verdict: "PASS" | "NEEDS_REVISION" | "REJECTED";
  readonly reviewFindings: readonly string[];
  readonly actionableFixes: readonly string[];
  readonly artifactReferences: readonly string[];
}

export interface VerifierInput {
  readonly tests: {
    readonly passed: boolean;
    readonly totalTests: number;
    readonly failedTests: number;
  };
  readonly acceptanceEvidence: readonly string[];
  readonly gitState: {
    readonly branch: string;
    readonly commitHash: string;
    readonly dirty: boolean;
  };
  readonly prState?: {
    readonly number: number;
    readonly state: "OPEN" | "CLOSED" | "MERGED";
    readonly merged: boolean;
  };
}

export interface VerifierOutput {
  readonly verified: boolean;
  readonly verificationSummary: string;
  readonly missingEvidence: readonly string[];
  readonly artifactReferences: readonly string[];
}

export interface HandoffInput {
  readonly gitState: {
    readonly branch: string;
    readonly commitHash: string;
    readonly dirty: boolean;
    readonly worktreePath: string;
  };
  readonly completedSteps: readonly string[];
  readonly failureReason?: string;
  readonly resumeNode: string;
}

export interface HandoffOutput {
  readonly acknowledged: boolean;
  readonly resumeNode: string;
  readonly nextStep: string;
}

/* ------------------------------------------------------------------ */
/* Validation Functions & Helpers                                     */
/* ------------------------------------------------------------------ */

function isObject(val: unknown): val is Record<string, unknown> {
  return typeof val === "object" && val !== null && !Array.isArray(val);
}

function isString(val: unknown): val is string {
  return typeof val === "string";
}

function isNumber(val: unknown): val is number {
  return typeof val === "number" && !Number.isNaN(val);
}

function isBoolean(val: unknown): val is boolean {
  return typeof val === "boolean";
}

function isStringArray(val: unknown): val is string[] {
  return Array.isArray(val) && val.every(isString);
}

/**
 * Keys that must never reach a role's context. Exported so the orchestrator's
 * dispatch-payload guard (`scripts/project-issue-roles.mjs`) can be checked
 * against the same list.
 */
export const DISALLOWED_KEYS = new Set([
  "chainOfThought",
  "chain_of_thought",
  "cot",
  "rawResponse",
  "raw_response",
  "rawModelResponse",
  "raw_model_response",
  "conversationHistory",
  "conversation_history",
  "fullConversation",
  "full_conversation",
  "toolHistory",
  "tool_history",
  "apiKey",
  "api_key",
  "credential",
  "credentials",
  "password",
  "secret",
  "prompt",
  "systemPrompt",
  "userPrompt",
]);

function checkForDisallowedKeys(obj: unknown, path = ""): void {
  if (!isObject(obj) && !Array.isArray(obj)) return;
  if (Array.isArray(obj)) {
    obj.forEach((item, index) => checkForDisallowedKeys(item, `${path}[${index}]`));
    return;
  }
  for (const key of Object.keys(obj)) {
    if (DISALLOWED_KEYS.has(key)) {
      throw new Error(`Disallowed field '${key}' detected in role schema context at ${path || "root"}`);
    }
    checkForDisallowedKeys(obj[key], path ? `${path}.${key}` : key);
  }
}

export function validateSharedFacts(data: unknown): SharedFacts {
  checkForDisallowedKeys(data);
  if (!isObject(data)) throw new Error("SharedFacts must be an object");
  if (!isNumber(data["issueNumber"])) throw new Error("SharedFacts.issueNumber must be a number");
  if (!isStringArray(data["acceptanceCriteria"]))
    throw new Error("SharedFacts.acceptanceCriteria must be an array of strings");
  if (!isStringArray(data["repositoryRules"]))
    throw new Error("SharedFacts.repositoryRules must be an array of strings");

  const git = data["gitState"];
  if (!isObject(git)) throw new Error("SharedFacts.gitState must be an object");
  if (!isString(git["branch"])) throw new Error("SharedFacts.gitState.branch must be a string");
  if (!isString(git["commitHash"])) throw new Error("SharedFacts.gitState.commitHash must be a string");
  if (!isBoolean(git["dirty"])) throw new Error("SharedFacts.gitState.dirty must be a boolean");
  if (git["upstream"] !== undefined && !isString(git["upstream"])) {
    throw new Error("SharedFacts.gitState.upstream must be a string if provided");
  }

  return {
    issueNumber: data["issueNumber"],
    acceptanceCriteria: data["acceptanceCriteria"],
    repositoryRules: data["repositoryRules"],
    gitState: {
      branch: git["branch"],
      commitHash: git["commitHash"],
      dirty: git["dirty"],
      ...(git["upstream"] !== undefined ? { upstream: git["upstream"] as string } : {}),
    },
  };
}

export function validatePlannerInput(data: unknown): PlannerInput {
  checkForDisallowedKeys(data);
  if (!isObject(data)) throw new Error("PlannerInput must be an object");
  const sharedFacts = validateSharedFacts(data["sharedFacts"]);
  if (!isString(data["issueTitle"])) throw new Error("PlannerInput.issueTitle must be a string");
  if (!isString(data["issueBody"])) throw new Error("PlannerInput.issueBody must be a string");
  if (data["targetFiles"] !== undefined && !isStringArray(data["targetFiles"])) {
    throw new Error("PlannerInput.targetFiles must be an array of strings if provided");
  }

  return {
    sharedFacts,
    issueTitle: data["issueTitle"],
    issueBody: data["issueBody"],
    ...(data["targetFiles"] !== undefined ? { targetFiles: data["targetFiles"] as string[] } : {}),
  };
}

export function validatePlannerOutput(data: unknown): PlannerOutput {
  checkForDisallowedKeys(data);
  if (!isObject(data)) throw new Error("PlannerOutput must be an object");
  if (!isString(data["planSummary"])) throw new Error("PlannerOutput.planSummary must be a string");
  if (!isStringArray(data["proposedSteps"])) throw new Error("PlannerOutput.proposedSteps must be an array of strings");
  if (
    data["estimatedRisk"] !== undefined &&
    !["low", "medium", "high"].includes(data["estimatedRisk"] as string)
  ) {
    throw new Error("PlannerOutput.estimatedRisk must be 'low', 'medium', or 'high'");
  }
  if (!isStringArray(data["artifactReferences"])) {
    throw new Error("PlannerOutput.artifactReferences must be an array of strings");
  }

  return {
    planSummary: data["planSummary"],
    proposedSteps: data["proposedSteps"],
    ...(data["estimatedRisk"] !== undefined
      ? { estimatedRisk: data["estimatedRisk"] as "low" | "medium" | "high" }
      : {}),
    artifactReferences: data["artifactReferences"],
  };
}

export function validateAnalystInput(data: unknown): AnalystInput {
  checkForDisallowedKeys(data);
  if (!isObject(data)) throw new Error("AnalystInput must be an object");
  const sharedFacts = validateSharedFacts(data["sharedFacts"]);
  if (!isString(data["planSummary"])) throw new Error("AnalystInput.planSummary must be a string");
  if (!isStringArray(data["targetFiles"])) throw new Error("AnalystInput.targetFiles must be an array of strings");
  if (data["focusAreas"] !== undefined && !isStringArray(data["focusAreas"])) {
    throw new Error("AnalystInput.focusAreas must be an array of strings if provided");
  }

  return {
    sharedFacts,
    planSummary: data["planSummary"],
    targetFiles: data["targetFiles"],
    ...(data["focusAreas"] !== undefined ? { focusAreas: data["focusAreas"] as string[] } : {}),
  };
}

export function validateAnalystOutput(data: unknown): AnalystOutput {
  checkForDisallowedKeys(data);
  if (!isObject(data)) throw new Error("AnalystOutput must be an object");
  if (!isStringArray(data["analysisFindings"]))
    throw new Error("AnalystOutput.analysisFindings must be an array of strings");
  if (!isStringArray(data["potentialRisks"]))
    throw new Error("AnalystOutput.potentialRisks must be an array of strings");
  if (!isStringArray(data["artifactReferences"]))
    throw new Error("AnalystOutput.artifactReferences must be an array of strings");

  return {
    analysisFindings: data["analysisFindings"],
    potentialRisks: data["potentialRisks"],
    artifactReferences: data["artifactReferences"],
  };
}

export function validateImplementerInput(data: unknown): ImplementerInput {
  checkForDisallowedKeys(data);
  if (!isObject(data)) throw new Error("ImplementerInput must be an object");
  const sharedFacts = validateSharedFacts(data["sharedFacts"]);
  if (!isString(data["planSummary"])) throw new Error("ImplementerInput.planSummary must be a string");
  if (!isStringArray(data["analysisFindings"]))
    throw new Error("ImplementerInput.analysisFindings must be an array of strings");
  if (!isStringArray(data["targetFiles"]))
    throw new Error("ImplementerInput.targetFiles must be an array of strings");

  return {
    sharedFacts,
    planSummary: data["planSummary"],
    analysisFindings: data["analysisFindings"],
    targetFiles: data["targetFiles"],
  };
}

export function validateImplementerOutput(data: unknown): ImplementerOutput {
  checkForDisallowedKeys(data);
  if (!isObject(data)) throw new Error("ImplementerOutput must be an object");
  if (!isStringArray(data["changedFiles"]))
    throw new Error("ImplementerOutput.changedFiles must be an array of strings");
  if (!isString(data["summaryOfChanges"]))
    throw new Error("ImplementerOutput.summaryOfChanges must be a string");
  if (!isStringArray(data["artifactReferences"]))
    throw new Error("ImplementerOutput.artifactReferences must be an array of strings");

  return {
    changedFiles: data["changedFiles"],
    summaryOfChanges: data["summaryOfChanges"],
    artifactReferences: data["artifactReferences"],
  };
}

export function validateReviewerInput(data: unknown): ReviewerInput {
  checkForDisallowedKeys(data);
  if (!isObject(data)) throw new Error("ReviewerInput must be an object");
  if (!isStringArray(data["acceptanceCriteria"]))
    throw new Error("ReviewerInput.acceptanceCriteria must be an array of strings");
  if (!isString(data["diffReference"])) throw new Error("ReviewerInput.diffReference must be a string");
  if (!isStringArray(data["changedFiles"]))
    throw new Error("ReviewerInput.changedFiles must be an array of strings");

  const ts = data["testSummary"];
  if (!isObject(ts)) throw new Error("ReviewerInput.testSummary must be an object");
  if (!isBoolean(ts["passed"])) throw new Error("ReviewerInput.testSummary.passed must be a boolean");
  if (!isNumber(ts["totalTests"])) throw new Error("ReviewerInput.testSummary.totalTests must be a number");
  if (!isNumber(ts["failedTests"])) throw new Error("ReviewerInput.testSummary.failedTests must be a number");
  if (ts["coverageSummary"] !== undefined && !isString(ts["coverageSummary"])) {
    throw new Error("ReviewerInput.testSummary.coverageSummary must be a string if provided");
  }

  return {
    acceptanceCriteria: data["acceptanceCriteria"],
    diffReference: data["diffReference"],
    changedFiles: data["changedFiles"],
    testSummary: {
      passed: ts["passed"],
      totalTests: ts["totalTests"],
      failedTests: ts["failedTests"],
      ...(ts["coverageSummary"] !== undefined
        ? { coverageSummary: ts["coverageSummary"] as string }
        : {}),
    },
  };
}

export function validateReviewerOutput(data: unknown): ReviewerOutput {
  checkForDisallowedKeys(data);
  if (!isObject(data)) throw new Error("ReviewerOutput must be an object");
  if (!["PASS", "NEEDS_REVISION", "REJECTED"].includes(data["verdict"] as string)) {
    throw new Error("ReviewerOutput.verdict must be 'PASS', 'NEEDS_REVISION', or 'REJECTED'");
  }
  if (!isStringArray(data["reviewFindings"]))
    throw new Error("ReviewerOutput.reviewFindings must be an array of strings");
  if (!isStringArray(data["actionableFixes"]))
    throw new Error("ReviewerOutput.actionableFixes must be an array of strings");
  if (!isStringArray(data["artifactReferences"]))
    throw new Error("ReviewerOutput.artifactReferences must be an array of strings");

  return {
    verdict: data["verdict"] as "PASS" | "NEEDS_REVISION" | "REJECTED",
    reviewFindings: data["reviewFindings"],
    actionableFixes: data["actionableFixes"],
    artifactReferences: data["artifactReferences"],
  };
}

export function validateVerifierInput(data: unknown): VerifierInput {
  checkForDisallowedKeys(data);
  if (!isObject(data)) throw new Error("VerifierInput must be an object");

  const ts = data["tests"];
  if (!isObject(ts)) throw new Error("VerifierInput.tests must be an object");
  if (!isBoolean(ts["passed"])) throw new Error("VerifierInput.tests.passed must be a boolean");
  if (!isNumber(ts["totalTests"])) throw new Error("VerifierInput.tests.totalTests must be a number");
  if (!isNumber(ts["failedTests"])) throw new Error("VerifierInput.tests.failedTests must be a number");

  if (!isStringArray(data["acceptanceEvidence"]))
    throw new Error("VerifierInput.acceptanceEvidence must be an array of strings");

  const git = data["gitState"];
  if (!isObject(git)) throw new Error("VerifierInput.gitState must be an object");
  if (!isString(git["branch"])) throw new Error("VerifierInput.gitState.branch must be a string");
  if (!isString(git["commitHash"])) throw new Error("VerifierInput.gitState.commitHash must be a string");
  if (!isBoolean(git["dirty"])) throw new Error("VerifierInput.gitState.dirty must be a boolean");

  let prState: VerifierInput["prState"];
  if (data["prState"] !== undefined) {
    const pr = data["prState"];
    if (!isObject(pr)) throw new Error("VerifierInput.prState must be an object if provided");
    if (!isNumber(pr["number"])) throw new Error("VerifierInput.prState.number must be a number");
    if (!["OPEN", "CLOSED", "MERGED"].includes(pr["state"] as string)) {
      throw new Error("VerifierInput.prState.state must be 'OPEN', 'CLOSED', or 'MERGED'");
    }
    if (!isBoolean(pr["merged"])) throw new Error("VerifierInput.prState.merged must be a boolean");
    prState = {
      number: pr["number"],
      state: pr["state"] as "OPEN" | "CLOSED" | "MERGED",
      merged: pr["merged"],
    };
  }

  return {
    tests: {
      passed: ts["passed"],
      totalTests: ts["totalTests"],
      failedTests: ts["failedTests"],
    },
    acceptanceEvidence: data["acceptanceEvidence"],
    gitState: {
      branch: git["branch"],
      commitHash: git["commitHash"],
      dirty: git["dirty"],
    },
    ...(prState ? { prState } : {}),
  };
}

export function validateVerifierOutput(data: unknown): VerifierOutput {
  checkForDisallowedKeys(data);
  if (!isObject(data)) throw new Error("VerifierOutput must be an object");
  if (!isBoolean(data["verified"])) throw new Error("VerifierOutput.verified must be a boolean");
  if (!isString(data["verificationSummary"]))
    throw new Error("VerifierOutput.verificationSummary must be a string");
  if (!isStringArray(data["missingEvidence"]))
    throw new Error("VerifierOutput.missingEvidence must be an array of strings");
  if (!isStringArray(data["artifactReferences"]))
    throw new Error("VerifierOutput.artifactReferences must be an array of strings");

  return {
    verified: data["verified"],
    verificationSummary: data["verificationSummary"],
    missingEvidence: data["missingEvidence"],
    artifactReferences: data["artifactReferences"],
  };
}

export function validateHandoffInput(data: unknown): HandoffInput {
  checkForDisallowedKeys(data);
  if (!isObject(data)) throw new Error("HandoffInput must be an object");

  const git = data["gitState"];
  if (!isObject(git)) throw new Error("HandoffInput.gitState must be an object");
  if (!isString(git["branch"])) throw new Error("HandoffInput.gitState.branch must be a string");
  if (!isString(git["commitHash"])) throw new Error("HandoffInput.gitState.commitHash must be a string");
  if (!isBoolean(git["dirty"])) throw new Error("HandoffInput.gitState.dirty must be a boolean");
  if (!isString(git["worktreePath"])) throw new Error("HandoffInput.gitState.worktreePath must be a string");

  if (!isStringArray(data["completedSteps"]))
    throw new Error("HandoffInput.completedSteps must be an array of strings");
  if (data["failureReason"] !== undefined && !isString(data["failureReason"])) {
    throw new Error("HandoffInput.failureReason must be a string if provided");
  }
  if (!isString(data["resumeNode"])) throw new Error("HandoffInput.resumeNode must be a string");

  return {
    gitState: {
      branch: git["branch"],
      commitHash: git["commitHash"],
      dirty: git["dirty"],
      worktreePath: git["worktreePath"],
    },
    completedSteps: data["completedSteps"],
    ...(data["failureReason"] !== undefined ? { failureReason: data["failureReason"] as string } : {}),
    resumeNode: data["resumeNode"],
  };
}

export function validateHandoffOutput(data: unknown): HandoffOutput {
  checkForDisallowedKeys(data);
  if (!isObject(data)) throw new Error("HandoffOutput must be an object");
  if (!isBoolean(data["acknowledged"])) throw new Error("HandoffOutput.acknowledged must be a boolean");
  if (!isString(data["resumeNode"])) throw new Error("HandoffOutput.resumeNode must be a string");
  if (!isString(data["nextStep"])) throw new Error("HandoffOutput.nextStep must be a string");

  return {
    acknowledged: data["acknowledged"],
    resumeNode: data["resumeNode"],
    nextStep: data["nextStep"],
  };
}
