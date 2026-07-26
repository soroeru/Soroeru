import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import {
  validateSharedFacts,
  validatePlannerInput,
  validatePlannerOutput,
  validateAnalystInput,
  validateAnalystOutput,
  validateImplementerInput,
  validateImplementerOutput,
  validateReviewerInput,
  validateReviewerOutput,
  validateVerifierInput,
  validateVerifierOutput,
  validateHandoffInput,
  validateHandoffOutput,
  DISALLOWED_KEYS,
} from "../../src/shared/role-schemas.js";

test("validateSharedFacts validates valid SharedFacts object", () => {
  const valid = {
    issueNumber: 441,
    acceptanceCriteria: ["criterion 1", "criterion 2"],
    repositoryRules: ["rule 1"],
    gitState: {
      branch: "issue-441-role-context-schemas",
      commitHash: "abc1234",
      dirty: false,
      upstream: "origin/main",
    },
  };
  const result = validateSharedFacts(valid);
  assert.deepEqual(result, valid);
});

test("validatePlannerInput and validatePlannerOutput validate correctly", () => {
  const input = {
    sharedFacts: {
      issueNumber: 441,
      acceptanceCriteria: ["criteria"],
      repositoryRules: ["rule"],
      gitState: { branch: "main", commitHash: "123", dirty: false },
    },
    issueTitle: "Title",
    issueBody: "Body",
    targetFiles: ["src/shared/role-schemas.ts"],
  };
  assert.deepEqual(validatePlannerInput(input), input);

  const output = {
    planSummary: "Summary of plan",
    proposedSteps: ["Step 1", "Step 2"],
    estimatedRisk: "low" as const,
    artifactReferences: ["docs/design/issue-441.md"],
  };
  assert.deepEqual(validatePlannerOutput(output), output);
});

test("validateAnalystInput and validateAnalystOutput validate correctly", () => {
  const input = {
    sharedFacts: {
      issueNumber: 441,
      acceptanceCriteria: ["criteria"],
      repositoryRules: ["rule"],
      gitState: { branch: "main", commitHash: "123", dirty: false },
    },
    planSummary: "Plan summary",
    targetFiles: ["src/shared/role-schemas.ts"],
  };
  assert.deepEqual(validateAnalystInput(input), input);

  const output = {
    analysisFindings: ["Finding 1"],
    potentialRisks: ["Risk 1"],
    artifactReferences: [],
  };
  assert.deepEqual(validateAnalystOutput(output), output);
});

test("validateImplementerInput and validateImplementerOutput validate correctly", () => {
  const input = {
    sharedFacts: {
      issueNumber: 441,
      acceptanceCriteria: ["criteria"],
      repositoryRules: ["rule"],
      gitState: { branch: "main", commitHash: "123", dirty: false },
    },
    planSummary: "Plan summary",
    analysisFindings: ["Finding 1"],
    targetFiles: ["src/shared/role-schemas.ts"],
  };
  assert.deepEqual(validateImplementerInput(input), input);

  const output = {
    changedFiles: ["src/shared/role-schemas.ts"],
    summaryOfChanges: "Added schemas",
    artifactReferences: [],
  };
  assert.deepEqual(validateImplementerOutput(output), output);
});

test("validateReviewerInput validates isolated input (no full conversation or CoT)", () => {
  const input = {
    acceptanceCriteria: ["criteria 1"],
    diffReference: "git diff origin/main",
    changedFiles: ["src/shared/role-schemas.ts"],
    testSummary: {
      passed: true,
      totalTests: 10,
      failedTests: 0,
      coverageSummary: "100%",
    },
  };
  assert.deepEqual(validateReviewerInput(input), input);

  const output = {
    verdict: "PASS" as const,
    reviewFindings: ["Good work"],
    actionableFixes: [],
    artifactReferences: [],
  };
  assert.deepEqual(validateReviewerOutput(output), output);
});

test("validateVerifierInput and validateVerifierOutput validate objective evidence", () => {
  const input = {
    tests: {
      passed: true,
      totalTests: 10,
      failedTests: 0,
    },
    acceptanceEvidence: ["Unit tests passed", "Schema checks passed"],
    gitState: {
      branch: "issue-441-role-context-schemas",
      commitHash: "123456",
      dirty: false,
    },
    prState: {
      number: 441,
      state: "OPEN" as const,
      merged: false,
    },
  };
  assert.deepEqual(validateVerifierInput(input), input);

  const output = {
    verified: true,
    verificationSummary: "All evidence verified",
    missingEvidence: [],
    artifactReferences: [],
  };
  assert.deepEqual(validateVerifierOutput(output), output);
});

test("validateHandoffInput and validateHandoffOutput validate worktree resume state", () => {
  const input = {
    gitState: {
      branch: "issue-441-role-context-schemas",
      commitHash: "123456",
      dirty: false,
      worktreePath: "/Users/shinichi/app/Soroeru/.worktrees/issue-441-role-context-schemas",
    },
    completedSteps: ["step1", "step2"],
    failureReason: "timeout",
    resumeNode: "reviewer",
  };
  assert.deepEqual(validateHandoffInput(input), input);

  const output = {
    acknowledged: true,
    resumeNode: "reviewer",
    nextStep: "run review pass",
  };
  assert.deepEqual(validateHandoffOutput(output), output);
});

test("schema validation rejects disallowed keys (CoT, full conversation, raw model response, credentials)", () => {
  const disallowedKeys = [
    "chainOfThought",
    "rawModelResponse",
    "conversationHistory",
    "toolHistory",
    "apiKey",
    "password",
  ];

  for (const key of disallowedKeys) {
    const invalidInput = {
      sharedFacts: {
        issueNumber: 441,
        acceptanceCriteria: ["criteria"],
        repositoryRules: ["rule"],
        gitState: { branch: "main", commitHash: "123", dirty: false },
      },
      issueTitle: "Title",
      issueBody: "Body",
      [key]: "disallowed content",
    };

    assert.throws(
      () => validatePlannerInput(invalidInput),
      /Disallowed field/i,
      `Expected ${key} to be rejected`,
    );
  }
});

test("the orchestrator dispatch guard shares the role-schema deny-list", async () => {
  const module = await import(
    pathToFileURL(join(process.cwd(), "scripts", "project-issue-roles.mjs")).href
  );
  const payloadKeys: string[] = module.DISALLOWED_PAYLOAD_KEYS;
  assert.deepEqual([...payloadKeys].sort(), [...DISALLOWED_KEYS].sort());
});

test("a reviewer worker's own context still validates as ReviewerInput", () => {
  // The parent never carries acceptance criteria, diffs, or test results; the
  // reviewer worker assembles them locally. This pins the shape it must build.
  const reviewerContext = validateReviewerInput({
    acceptanceCriteria: ["role programs dispatch a distinct reviewer"],
    diffReference: "origin/main...issue-482-role-based-worker-dispatch",
    changedFiles: ["scripts/project-issue-roles.mjs"],
    testSummary: { passed: true, totalTests: 41, failedTests: 0 },
  });
  assert.equal(reviewerContext.changedFiles.length, 1);
  assert.throws(
    () =>
      validateReviewerInput({
        acceptanceCriteria: [],
        diffReference: "ref",
        changedFiles: [],
        testSummary: { passed: true, totalTests: 0, failedTests: 0 },
        chainOfThought: "implementer reasoning",
      }),
    /Disallowed field 'chainOfThought'/,
  );
});
