// Local-only diagnostics and redacted support bundle export (#90).
//
// Diagnostic events are stored encrypted in PocStore because even site/activity
// summaries can be sensitive. Export is explicit and redacted: no raw profile
// values, API keys, prompts, cookies, vault bytes, screenshots, or logs.

import { arch, platform, release, type } from "node:os";
import pkg from "../../package.json" with { type: "json" };
import type { DiagnosticEvent, PocStore } from "../store/store.js";

export interface SupportBundle {
  schema: "catashiro-support-bundle-v1";
  generatedAt: string;
  app: {
    name: string;
    version: string;
  };
  runtime: {
    node: string;
    platform: string;
    osType: string;
    osRelease: string;
    arch: string;
  };
  diagnostics: DiagnosticEvent[];
  privacy: {
    redacted: true;
    excludes: string[];
  };
}

const EXCLUDED_FROM_BUNDLE = [
  "raw personal values",
  "vault bytes",
  "API keys",
  "passphrases",
  "recovery keys",
  "AI prompts",
  "cookies",
  "browser sessions",
  "screenshots",
  "Playwright traces",
];

const SECRETISH =
  /([A-Z2-7]{4}-){4,}|sk-[A-Za-z0-9_-]+|[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}|\b(?:\d[ -]?){12,19}\b|\b(?:\d{2,4}-?\d{3,4}-?\d{4})\b/g;

export function redactDiagnosticText(value: string): string {
  return value.replace(SECRETISH, "[redacted]");
}

function redactMetadata(metadata: DiagnosticEvent["metadata"]): DiagnosticEvent["metadata"] {
  if (!metadata) return undefined;
  const redacted: NonNullable<DiagnosticEvent["metadata"]> = {};
  for (const [key, value] of Object.entries(metadata)) {
    redacted[key] = typeof value === "string" ? redactDiagnosticText(value) : value;
  }
  return redacted;
}

export function sanitizeDiagnosticEvent(event: DiagnosticEvent): DiagnosticEvent {
  const sanitized: DiagnosticEvent = {
    id: event.id,
    at: event.at,
    type: event.type,
    message: redactDiagnosticText(event.message),
    severity: event.severity,
  };
  const metadata = redactMetadata(event.metadata);
  if (metadata) sanitized.metadata = metadata;
  return sanitized;
}

export function buildSupportBundle(store: PocStore, limit = 50): SupportBundle {
  return {
    schema: "catashiro-support-bundle-v1",
    generatedAt: new Date().toISOString(),
    app: {
      name: pkg.name,
      version: pkg.version,
    },
    runtime: {
      node: process.versions.node,
      platform: platform(),
      osType: type(),
      osRelease: release(),
      arch: arch(),
    },
    diagnostics: store.listDiagnosticEvents(limit).map(sanitizeDiagnosticEvent),
    privacy: {
      redacted: true,
      excludes: EXCLUDED_FROM_BUNDLE,
    },
  };
}

export function exportSupportBundleJson(store: PocStore, limit = 50): string {
  return JSON.stringify(buildSupportBundle(store, limit), null, 2);
}
