/**
 * Schema definition, validation, aggregation, and migration for Soroeru's
 * versioned and privacy-preserving orchestration, quality, and token-efficiency
 * telemetry events.
 *
 * Privacy Rules:
 * - NO raw prompts, model responses, Issue bodies/titles, code diffs,
 *   credentials, or personal identifiable information (PII).
 * - Exact, estimate, and unavailable token/cost usage must be explicitly tagged.
 * - Route decisions and terminal outcomes correlate via correlationId.
 */

const PROHIBITED_FIELDS = new Set([
  "prompt",
  "response",
  "body",
  "title",
  "diff",
  "code",
  "credential",
  "credentials",
  "token_secret",
  "api_key",
  "password",
  "secret",
  "personal_data",
  "pii",
]);

const VALID_EVENT_TYPES = new Set(["route_decision", "role_execution", "terminal_outcome"]);
const VALID_AVAILABILITY = new Set(["exact", "estimate", "unavailable"]);
const VALID_AGENTS = new Set(["Codex", "Claude", "Grok", "Gemini"]);
const VALID_MODES = new Set(["single-agent", "multi-agent", "bounded-retry"]);
const VALID_EXIT_CLASSIFICATIONS = new Set([
  "success",
  "failed",
  "timeout",
  "abandoned",
  "cancelled",
  "error",
]);
const VALID_TERMINAL_STATUSES = new Set([
  "merged",
  "closed_unmerged",
  "failed",
  "cancelled",
  "in_progress",
]);
const VALID_PR_STATES = new Set(["merged", "open", "closed", "not_created"]);

export const VALID_FAILURE_REASON_CODES = new Set([
  "none",
  "duplicate_node_execution",
  "abandoned_worker",
  "timeout",
  "failed_handoff",
  "tests_failed",
  "review_failed",
  "gate_failed",
  "user_cancelled",
  "unknown",
]);

export const VALID_WASTE_REASON_CODES = new Set([
  "duplicate_node_execution",
  "abandoned_worker",
  "timeout",
  "failed_handoff",
  "redundant_retry",
  "unnecessary_review",
]);

/**
 * Recursively scans object keys for privacy-prohibited field names.
 */
function checkForProhibitedFields(obj, path = "") {
  if (!obj || typeof obj !== "object") return;

  if (Array.isArray(obj)) {
    obj.forEach((item, idx) => checkForProhibitedFields(item, `${path}[${idx}]`));
    return;
  }

  for (const [key, value] of Object.entries(obj)) {
    const currentPath = path ? `${path}.${key}` : key;
    if (PROHIBITED_FIELDS.has(key.toLowerCase())) {
      throw new Error(`privacy-prohibited-field:${currentPath}`);
    }
    if (value && typeof value === "object") {
      checkForProhibitedFields(value, currentPath);
    }
  }
}

function validateUsageMetric(metric, path) {
  if (!metric || typeof metric !== "object") {
    throw new Error(`invalid-metric:${path}`);
  }
  if (!VALID_AVAILABILITY.has(metric.availability)) {
    throw new Error(`invalid-availability:${path}.availability`);
  }

  if (metric.availability === "unavailable") {
    if (typeof metric.reasonCode !== "string" || !metric.reasonCode) {
      throw new Error(`missing-reason-code:${path}.reasonCode`);
    }
    if ("value" in metric && metric.value !== undefined) {
      throw new Error(`value-not-allowed-for-unavailable:${path}.value`);
    }
  } else {
    if (typeof metric.value !== "number" || Number.isNaN(metric.value) || metric.value < 0) {
      throw new Error(`invalid-metric-value:${path}.value`);
    }
  }
}

/**
 * Validates a telemetry event against schema v1.
 */
export function validateTelemetryEvent(event) {
  if (!event || typeof event !== "object") {
    throw new Error("invalid-event:must-be-object");
  }

  // Privacy scan on entire event
  checkForProhibitedFields(event);

  if (event.schemaVersion !== 1) {
    throw new Error(`unsupported-schema-version:${event.schemaVersion}`);
  }
  if (typeof event.eventId !== "string" || !event.eventId) {
    throw new Error("invalid-event-id");
  }
  if (typeof event.correlationId !== "string" || !event.correlationId) {
    throw new Error("invalid-correlation-id");
  }
  if (typeof event.occurredAt !== "string" || Number.isNaN(Date.parse(event.occurredAt))) {
    throw new Error("invalid-occurred-at");
  }
  if (!VALID_EVENT_TYPES.has(event.type)) {
    throw new Error(`invalid-event-type:${event.type}`);
  }
  if (typeof event.issueNumber !== "number" || event.issueNumber <= 0) {
    throw new Error("invalid-issue-number");
  }

  const payload = event.payload;
  if (!payload || typeof payload !== "object") {
    throw new Error("invalid-payload");
  }

  if (event.type === "route_decision") {
    if (typeof payload.role !== "string" || !payload.role) {
      throw new Error("invalid-route-role");
    }
    if (!VALID_MODES.has(payload.mode)) {
      throw new Error(`invalid-route-mode:${payload.mode}`);
    }
    if (!Array.isArray(payload.candidates) || payload.candidates.length === 0) {
      throw new Error("invalid-route-candidates");
    }
    for (const cand of payload.candidates) {
      if (!cand || !VALID_AGENTS.has(cand.agent) || typeof cand.model !== "string") {
        throw new Error("invalid-route-candidate");
      }
    }
    if (!payload.selected || !VALID_AGENTS.has(payload.selected.agent) || typeof payload.selected.model !== "string") {
      throw new Error("invalid-route-selected");
    }
    if (typeof payload.reasonCode !== "string" || !payload.reasonCode) {
      throw new Error("invalid-route-reason-code");
    }
  } else if (event.type === "role_execution") {
    if (typeof payload.role !== "string" || !payload.role) {
      throw new Error("invalid-role");
    }
    if (!VALID_AGENTS.has(payload.agent)) {
      throw new Error(`invalid-agent:${payload.agent}`);
    }
    if (typeof payload.model !== "string" || !payload.model) {
      throw new Error("invalid-model");
    }

    validateUsageMetric(payload.durationMs, "payload.durationMs");

    if (!payload.tokens || typeof payload.tokens !== "object") {
      throw new Error("invalid-tokens-object");
    }
    validateUsageMetric(payload.tokens.input, "payload.tokens.input");
    validateUsageMetric(payload.tokens.output, "payload.tokens.output");
    validateUsageMetric(payload.tokens.total, "payload.tokens.total");

    if (payload.costUsd) {
      validateUsageMetric(payload.costUsd, "payload.costUsd");
    }

    if (!VALID_EXIT_CLASSIFICATIONS.has(payload.exitClassification)) {
      throw new Error(`invalid-exit-classification:${payload.exitClassification}`);
    }
  } else if (event.type === "terminal_outcome") {
    if (!VALID_TERMINAL_STATUSES.has(payload.status)) {
      throw new Error(`invalid-terminal-status:${payload.status}`);
    }
    if (!VALID_FAILURE_REASON_CODES.has(payload.failureReasonCode)) {
      throw new Error(`invalid-failure-reason-code:${payload.failureReasonCode}`);
    }
    if (!VALID_PR_STATES.has(payload.prState)) {
      throw new Error(`invalid-pr-state:${payload.prState}`);
    }
    if (typeof payload.humanIntervention !== "boolean") {
      throw new Error("invalid-human-intervention");
    }
    if (typeof payload.handoffCount !== "number" || payload.handoffCount < 0) {
      throw new Error("invalid-handoff-count");
    }
    if (!Array.isArray(payload.wasteReasonCodes)) {
      throw new Error("invalid-waste-reason-codes");
    }
    for (const code of payload.wasteReasonCodes) {
      if (!VALID_WASTE_REASON_CODES.has(code)) {
        throw new Error(`invalid-waste-reason-code:${code}`);
      }
    }
  }

  return event;
}

/**
 * Aggregates token metrics across events by Issue and by Role.
 */
export function aggregateTokenUsage(events) {
  const byIssue = {};
  const byRole = {};

  for (const rawEvent of events) {
    const event = validateTelemetryEvent(rawEvent);
    if (event.type !== "role_execution") continue;

    const issueKey = String(event.issueNumber);
    const roleKey = event.payload.role;
    const tokens = event.payload.tokens;

    // We count metrics from input, output, total
    const metrics = [tokens.input, tokens.output, tokens.total];

    for (const target of [byIssue, byRole]) {
      const key = target === byIssue ? issueKey : roleKey;
      if (!target[key]) {
        target[key] = { exact: 0, estimate: 0, unavailable: 0 };
      }
      for (const m of metrics) {
        if (!m) continue;
        if (m.availability === "exact") {
          target[key].exact += m.value;
        } else if (m.availability === "estimate") {
          target[key].estimate += m.value;
        } else if (m.availability === "unavailable") {
          target[key].unavailable += 1;
        }
      }
    }
  }

  return { byIssue, byRole };
}

/**
 * Migrates a legacy schema (v0) telemetry event to schemaVersion 1.
 */
export function migrateTelemetryEvent(legacyEvent) {
  if (!legacyEvent || typeof legacyEvent !== "object") {
    throw new Error("invalid-legacy-event");
  }

  const version = legacyEvent.schemaVersion ?? legacyEvent.version;
  if (version === 1) {
    return validateTelemetryEvent(legacyEvent);
  }

  if (version === 0) {
    const migrated = {
      schemaVersion: 1,
      eventId: legacyEvent.id ?? `evt-${Date.now()}`,
      correlationId: legacyEvent.runId ?? `run-${legacyEvent.issue ?? "unknown"}`,
      occurredAt: legacyEvent.timestamp ?? new Date().toISOString(),
      type: legacyEvent.eventType ?? "terminal_outcome",
      issueNumber: legacyEvent.issue,
      payload: {
        status: legacyEvent.data?.status ?? "failed",
        failureReasonCode: legacyEvent.data?.failureReasonCode ?? "unknown",
        prState: legacyEvent.data?.prState ?? "not_created",
        humanIntervention: Boolean(legacyEvent.data?.humanIntervention),
        handoffCount: legacyEvent.data?.handoffCount ?? 0,
        wasteReasonCodes: legacyEvent.data?.wasteReasonCodes ?? [],
      },
    };
    return validateTelemetryEvent(migrated);
  }

  throw new Error(`unsupported-legacy-version:${version}`);
}
