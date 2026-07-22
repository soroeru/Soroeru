import {
  DEFAULT_HEADLESS_PROBE_TIMEOUT_MS,
  DEFAULT_PROBE_TIMEOUT_MS,
  DEFAULT_WORKER_TIMEOUT_MS,
  REASON_CODES,
  buildWorkerPrompt,
  capabilityRecord,
  diagnostic,
  quoteSelectorArg,
  resolveExecutable,
  runHeadlessExecProbe,
  runProcess,
  spawnWorker,
  splitSelector,
} from "./shared.mjs";

export const agent = "Gemini";
export const evaluationOrder = 3;

/**
 * Antigravity (`agy`) is the Gemini runtime used in this repository.
 * A bare `gemini` CLI is also accepted when present, but never invented.
 */
const CLI_NAMES = ["agy", "gemini"];

function parseAgyModels(stdout) {
  const text = String(stdout ?? "").trim();
  if (!text) return null;
  try {
    const json = JSON.parse(text);
    if (Array.isArray(json)) {
      return json
        .map((entry) => {
          const id = typeof entry === "string" ? entry : entry?.id ?? entry?.model ?? entry?.name;
          if (typeof id !== "string" || !id.trim()) return null;
          return { model: id.trim(), requestedModel: id.trim() };
        })
        .filter(Boolean);
    }
  } catch {
    // line list
  }
  const models = [];
  for (const line of text.split(/\r?\n/)) {
    const name = line.trim();
    if (!name) continue;
    if (/^available models/i.test(name) || /^usage of/i.test(name)) continue;
    // Reject prose/tips: require a product-style model display name.
    // Real agy lines look like "Gemini 3.1 Pro (High)" / "Claude Sonnet 4.6 (Thinking)".
    if (!/^(Gemini|Claude|GPT)\b/i.test(name)) continue;
    if (/[.!?]$/.test(name)) continue;
    models.push({ model: name, requestedModel: name });
  }
  return models.length ? models : null;
}

export async function discover(ctx = {}) {
  const timeoutMs = ctx.timeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS;
  const workerTimeoutMs = ctx.workerTimeoutMs ?? DEFAULT_WORKER_TIMEOUT_MS;
  const run = ctx.runProcess ?? runProcess;
  const resolve = ctx.resolveExecutable ?? resolveExecutable;
  const env = ctx.env ?? process.env;
  const diagnostics = [];
  const records = [];

  let cliPath = null;
  let cliName = null;
  const names = ctx.cliPath ? [ctx.cliPath] : CLI_NAMES;
  for (const name of names) {
    const resolved = await resolve(name, { env, pathEnv: ctx.pathEnv });
    if (resolved) {
      cliPath = resolved;
      cliName = name;
      break;
    }
  }
  if (!cliPath) {
    diagnostics.push(diagnostic({ agent, status: "failed", reason: REASON_CODES.CLI_NOT_FOUND }));
    return { records, diagnostics };
  }

  const listed = await run(cliPath, ["models"], { timeoutMs, env, cwd: ctx.cwd });
  if (listed.timedOut) {
    diagnostics.push(diagnostic({ agent, status: "failed", reason: REASON_CODES.VERIFICATION_TIMEOUT }));
    return { records, diagnostics };
  }
  if (listed.code !== 0) {
    diagnostics.push(diagnostic({ agent, status: "failed", reason: REASON_CODES.AUTH_UNAVAILABLE }));
    return { records, diagnostics };
  }

  const models = parseAgyModels(listed.stdout);
  if (!models?.length) {
    diagnostics.push(diagnostic({ agent, status: "failed", reason: REASON_CODES.MODEL_NOT_SELECTABLE }));
    return { records, diagnostics };
  }

  const candidates = [];
  for (const { model, requestedModel } of models) {
    // Prefer print/non-interactive flags for agy when launching workers.
    const modelArg = quoteSelectorArg(model);
    if (!modelArg) {
      diagnostics.push(
        diagnostic({ agent, status: "failed", reason: REASON_CODES.MODEL_NOT_SELECTABLE, model }),
      );
      continue;
    }
    // `--dangerously-skip-permissions` is required alongside `--print` for a
    // tool call (file write) to complete headlessly; without it `--print`
    // was observed to answer in prose and exit 0 with no artifact produced.
    const selector =
      cliName === "agy" || /\/agy$/.test(cliPath)
        ? `${cliPath} --model ${modelArg} --print --dangerously-skip-permissions`
        : `${cliPath} --model ${modelArg}`;
    candidates.push({ model, requestedModel, selector });
  }
  if (!candidates.length) return { records, diagnostics };

  const probe = ctx.headlessExecProbe ?? runHeadlessExecProbe;
  const probeTokens = splitSelector(candidates[0].selector);
  const probeResult = await probe({
    cliPath: probeTokens[0],
    args: probeTokens.slice(1),
    run,
    timeoutMs: ctx.headlessProbeTimeoutMs ?? DEFAULT_HEADLESS_PROBE_TIMEOUT_MS,
    env,
  });
  if (!probeResult.ok) {
    diagnostics.push(
      diagnostic({ agent, status: "failed", reason: probeResult.reason ?? REASON_CODES.HEADLESS_EXEC_FAILED }),
    );
    return { records, diagnostics };
  }

  for (const { model, requestedModel, selector } of candidates) {
    for (const role of ["worker", "parent"]) {
      records.push(
        capabilityRecord({
          agent,
          requestedModel,
          model,
          role,
          selector,
          timeoutMs: workerTimeoutMs,
        }),
      );
    }
    diagnostics.push(diagnostic({ agent, status: "ok", model }));
  }
  return { records, diagnostics, cliPath };
}

export async function launch(ctx, job) {
  const runSpawn = ctx.spawnWorker ?? spawnWorker;
  const resolve = ctx.resolveExecutable ?? resolveExecutable;
  const env = ctx.env ?? process.env;
  const tokens = splitSelector(job.selector);
  const command = tokens[0];
  const cliPath = (await resolve(command, { env, pathEnv: ctx.pathEnv })) ?? command;
  const prompt = buildWorkerPrompt(job);
  const args = [...tokens.slice(1), prompt];
  return runSpawn(cliPath, args, {
    timeoutMs: job.timeoutMs,
    env,
    cwd: job.cwd ?? ctx.cwd,
  });
}
