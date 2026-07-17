#!/usr/bin/env node

/**
 * Deterministic worker-runtime capability discovery for project-issue orchestration.
 *
 * Evaluates Codex → Claude → Grok → Gemini adapters in fixed order, emits only
 * verified capability records, and writes the result atomically. Diagnostics use
 * closed reason codes and never store credentials, prompts, Issue bodies, diffs,
 * or model response bodies.
 */

import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  DEFAULT_PROBE_TIMEOUT_MS,
  DEFAULT_WORKER_TIMEOUT_MS,
  writeJsonAtomic,
} from "./project-issue-runtime-adapters/shared.mjs";
import { discoverAllCapabilities } from "./project-issue-runtime-adapters/index.mjs";

export const DEFAULT_CAPABILITIES_OUTPUT = "state/project-issue-capabilities.json";

/**
 * Run discovery and optionally write an atomic capabilities file.
 *
 * @returns {{ capabilities: object[], diagnostics: object[], outputPath?: string }}
 */
export async function discoverCapabilities(options = {}) {
  const timeoutMs = options.timeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS;
  const workerTimeoutMs = options.workerTimeoutMs ?? DEFAULT_WORKER_TIMEOUT_MS;
  const result = await discoverAllCapabilities({
    timeoutMs,
    workerTimeoutMs,
    env: options.env,
    pathEnv: options.pathEnv,
    cwd: options.cwd,
    homeDir: options.homeDir,
    adapters: options.adapters,
    runProcess: options.runProcess,
    resolveExecutable: options.resolveExecutable,
  });

  // Strip anything that is not a closed diagnostic field (defense in depth).
  const diagnostics = (result.diagnostics ?? []).map((entry) => ({
    agent: entry.agent,
    status: entry.status,
    ...(entry.reason ? { reason: entry.reason } : {}),
    ...(entry.model ? { model: entry.model } : {}),
  }));

  const capabilities = (result.capabilities ?? []).filter(
    (record) =>
      record &&
      typeof record.agent === "string" &&
      typeof record.model === "string" &&
      typeof record.role === "string" &&
      typeof record.selector === "string" &&
      record.selectable === true &&
      record.verifiable === true &&
      Number.isSafeInteger(record.timeoutMs) &&
      record.timeoutMs > 0,
  );

  const payload = { capabilities, diagnostics };

  let outputPath;
  if (options.outputPath) {
    outputPath = await writeJsonAtomic(options.outputPath, payload);
  }

  return { ...payload, ...(outputPath ? { outputPath } : {}) };
}

export function parseCapabilitiesCliArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === "--stdout") {
      options.stdout = true;
      continue;
    }
    if (flag === "--output" || flag === "--output-path") {
      const value = argv[++index];
      if (value === undefined || value.startsWith("--")) throw new Error(`missing-flag-value:${flag}`);
      options.outputPath = value;
      continue;
    }
    if (flag === "--timeout-ms") {
      const value = argv[++index];
      if (value === undefined || value.startsWith("--")) throw new Error(`missing-flag-value:${flag}`);
      options.timeoutMs = Number(value);
      if (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs <= 0)
        throw new Error("invalid-timeout-ms");
      continue;
    }
    if (flag === "--worker-timeout-ms") {
      const value = argv[++index];
      if (value === undefined || value.startsWith("--")) throw new Error(`missing-flag-value:${flag}`);
      options.workerTimeoutMs = Number(value);
      if (!Number.isSafeInteger(options.workerTimeoutMs) || options.workerTimeoutMs <= 0)
        throw new Error("invalid-worker-timeout-ms");
      continue;
    }
    throw new Error(`unknown-flag:${flag}`);
  }
  return options;
}

async function main() {
  const cli = parseCapabilitiesCliArgs(process.argv.slice(2));
  const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const outputPath =
    cli.outputPath ??
    (cli.stdout ? undefined : path.join(repositoryRoot, DEFAULT_CAPABILITIES_OUTPUT));
  const result = await discoverCapabilities({
    outputPath,
    timeoutMs: cli.timeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS,
    workerTimeoutMs: cli.workerTimeoutMs ?? DEFAULT_WORKER_TIMEOUT_MS,
    cwd: repositoryRoot,
  });
  // Summary only on stdout when writing a file; full JSON when --stdout.
  if (cli.stdout || !outputPath) {
    process.stdout.write(`${JSON.stringify({ capabilities: result.capabilities, diagnostics: result.diagnostics })}\n`);
  } else {
    process.stdout.write(
      `${JSON.stringify({
        status: "ok",
        outputPath: result.outputPath,
        capabilityCount: result.capabilities.length,
        workerRouteCount: result.capabilities.filter((record) => record.role === "worker").length,
        diagnosticCount: result.diagnostics.length,
      })}\n`,
    );
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`${JSON.stringify({ status: "error", reason: error.message })}\n`);
    process.exitCode = 1;
  });
}
