import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  DEFAULT_PROBE_TIMEOUT_MS,
  DEFAULT_WORKER_TIMEOUT_MS,
  REASON_CODES,
  buildWorkerPrompt,
  capabilityRecord,
  diagnostic,
  resolveExecutable,
  runProcess,
  spawnWorker,
  splitSelector,
} from "./shared.mjs";

export const agent = "Claude";
export const evaluationOrder = 1;

const CLI_NAMES = ["claude"];

/** Documented Claude Code aliases used only when the CLI exposes a model list. */
const FALLBACK_CANDIDATES = ["sonnet", "opus", "fable", "haiku"];

function parseAuth(stdout) {
  try {
    const json = JSON.parse(String(stdout ?? "").trim());
    return json?.loggedIn === true;
  } catch {
    return /loggedIn"\s*:\s*true/.test(String(stdout ?? ""));
  }
}

function parseModelLines(stdout) {
  const text = String(stdout ?? "").trim();
  if (!text) return null;
  try {
    const json = JSON.parse(text);
    if (Array.isArray(json)) {
      return json
        .map((entry) => {
          if (typeof entry === "string") return { model: entry.trim(), requestedModel: entry.trim() };
          const id = entry?.id ?? entry?.model ?? entry?.slug;
          if (typeof id !== "string" || !id.trim()) return null;
          const label =
            typeof entry?.display_name === "string" && entry.display_name.trim()
              ? entry.display_name.trim()
              : id.trim();
          return { model: id.trim(), requestedModel: label };
        })
        .filter(Boolean);
    }
    if (Array.isArray(json?.models)) {
      return parseModelLines(JSON.stringify(json.models));
    }
  } catch {
    // line-oriented fallback
  }
  const models = [];
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || /^available models/i.test(trimmed) || /^default model/i.test(trimmed)) continue;
    const bullet = trimmed.replace(/^\*\s+/, "").replace(/^\-\s+/, "");
    const id = bullet.split(/\s+/)[0];
    if (!id || /:$/.test(id)) continue;
    // Skip prose sentences.
    if (/\s/.test(bullet) && !/^[a-z0-9._-]+$/i.test(id)) continue;
    if (/^[a-z0-9][a-z0-9._+-]*$/i.test(id)) models.push({ model: id, requestedModel: id });
  }
  return models.length ? models : null;
}

async function readSettingsModel(homeDir) {
  try {
    const raw = await fs.readFile(path.join(homeDir, ".claude", "settings.json"), "utf8");
    const settings = JSON.parse(raw);
    if (typeof settings?.model !== "string" || !settings.model.trim()) return null;
    // Strip UI suffixes such as `[1m]`.
    return settings.model.trim().replace(/\[[^\]]*\]\s*$/, "").trim();
  } catch {
    return null;
  }
}

/**
 * Discover Claude routes. Prefer a machine-readable model list from the CLI.
 * When the CLI cannot list models, fall back only to the settings-selected
 * model (exact identifier on disk) after auth succeeds — never invent aliases.
 */
export async function discover(ctx = {}) {
  const timeoutMs = ctx.timeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS;
  const workerTimeoutMs = ctx.workerTimeoutMs ?? DEFAULT_WORKER_TIMEOUT_MS;
  const run = ctx.runProcess ?? runProcess;
  const resolve = ctx.resolveExecutable ?? resolveExecutable;
  const env = ctx.env ?? process.env;
  const homeDir = ctx.homeDir ?? os.homedir();
  const diagnostics = [];
  const records = [];

  let cliPath = null;
  for (const name of CLI_NAMES) {
    cliPath = await resolve(ctx.cliPath ?? name, { env, pathEnv: ctx.pathEnv });
    if (cliPath) break;
  }
  if (!cliPath) {
    diagnostics.push(diagnostic({ agent, status: "failed", reason: REASON_CODES.CLI_NOT_FOUND }));
    return { records, diagnostics };
  }

  const auth = await run(cliPath, ["auth", "status"], { timeoutMs, env, cwd: ctx.cwd });
  if (auth.timedOut) {
    diagnostics.push(diagnostic({ agent, status: "failed", reason: REASON_CODES.VERIFICATION_TIMEOUT }));
    return { records, diagnostics };
  }
  if (!parseAuth(auth.stdout)) {
    diagnostics.push(diagnostic({ agent, status: "failed", reason: REASON_CODES.AUTH_UNAVAILABLE }));
    return { records, diagnostics };
  }

  let models = null;
  const listed = await run(cliPath, ["models"], { timeoutMs, env, cwd: ctx.cwd });
  if (listed.timedOut) {
    diagnostics.push(diagnostic({ agent, status: "failed", reason: REASON_CODES.VERIFICATION_TIMEOUT }));
    return { records, diagnostics };
  }
  if (listed.code === 0) {
    models = parseModelLines(listed.stdout);
  }

  if (!models?.length) {
    const settingsModel =
      typeof ctx.settingsModel === "string"
        ? ctx.settingsModel.trim()
        : await readSettingsModel(homeDir);
    if (settingsModel) {
      models = [{ model: settingsModel, requestedModel: settingsModel }];
    } else if (Array.isArray(ctx.candidateModels) && ctx.candidateModels.length) {
      // Explicit test/override candidates only — not used as production guesses.
      models = ctx.candidateModels.map((entry) =>
        typeof entry === "string"
          ? { model: entry, requestedModel: entry }
          : { model: entry.model, requestedModel: entry.requestedModel ?? entry.model },
      );
    } else if (ctx.allowFallbackCandidates) {
      models = FALLBACK_CANDIDATES.map((id) => ({ model: id, requestedModel: id }));
    }
  }

  if (!models?.length) {
    diagnostics.push(diagnostic({ agent, status: "failed", reason: REASON_CODES.MODEL_NOT_SELECTABLE }));
    return { records, diagnostics };
  }

  for (const { model, requestedModel } of models) {
    if (!model) {
      diagnostics.push(
        diagnostic({ agent, status: "failed", reason: REASON_CODES.MODEL_NOT_SELECTABLE, model }),
      );
      continue;
    }
    const selector = `${cliPath} --model ${model}`;
    for (const role of ["worker", "parent"]) {
      records.push(
        capabilityRecord({
          agent,
          requestedModel: requestedModel ?? model,
          model,
          role,
          selector,
          timeoutMs: workerTimeoutMs,
        }),
      );
    }
    diagnostics.push(diagnostic({ agent, status: "ok", model }));
  }
  return { records, diagnostics };
}

export async function launch(ctx, job) {
  const runSpawn = ctx.spawnWorker ?? spawnWorker;
  const resolve = ctx.resolveExecutable ?? resolveExecutable;
  const env = ctx.env ?? process.env;
  const tokens = splitSelector(job.selector);
  const command = tokens[0];
  const cliPath = (await resolve(command, { env, pathEnv: ctx.pathEnv })) ?? command;
  const prompt = buildWorkerPrompt(job);
  // Claude non-interactive: print mode with the worker contract as the prompt.
  const args = [...tokens.slice(1), "-p", prompt];
  return runSpawn(cliPath, args, {
    timeoutMs: job.timeoutMs,
    env,
    cwd: job.cwd ?? ctx.cwd,
  });
}
