import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

/** Closed diagnostic reason codes (no free-form secrets). */
export const REASON_CODES = Object.freeze({
  CLI_NOT_FOUND: "cli-not-found",
  AUTH_UNAVAILABLE: "auth-unavailable",
  MODEL_NOT_SELECTABLE: "model-not-selectable",
  MODEL_MISMATCH: "model-mismatch",
  VERIFICATION_TIMEOUT: "verification-timeout",
  PROBE_FAILED: "probe-failed",
  // Headless execution probe outcomes (Issue #434): a route only becomes
  // `verifiable: true` after it actually completes a minimal tool-use task
  // with no TTY attached, not merely after auth/model-list checks pass.
  TTY_REQUIRED: "tty-required",
  NON_AGENTIC_PRINT_MODE: "non-agentic-print-mode",
  HEADLESS_EXEC_FAILED: "headless-exec-failed",
});

// Bumped from 30s (Issue #434): the Claude CLI's `auth status` / `models`
// probes were observed timing out at 30s and passing at 120s in real runs.
export const DEFAULT_PROBE_TIMEOUT_MS = 60_000;
export const DEFAULT_WORKER_TIMEOUT_MS = 3_600_000;
// The headless execution probe spins up a real agent turn (not just a CLI
// status check), so it gets its own, longer budget.
export const DEFAULT_HEADLESS_PROBE_TIMEOUT_MS = 120_000;

export const PROBE_SCHEMA_VERSION = 2;

/** Stderr/stdout patterns that indicate the CLI demanded a real TTY/PTY. */
const TTY_REQUIRED_PATTERN =
  /(device not configured|inappropriate ioctl for device|enotty|not a tty|no such device or address|raw mode is not supported)/i;

/**
 * Resolve an executable on PATH (or an absolute path). Returns absolute path or null.
 */
export async function resolveExecutable(command, { env = process.env, pathEnv } = {}) {
  if (typeof command !== "string" || !command.trim()) return null;
  if (command.includes("/") || command.includes("\\")) {
    try {
      await fs.access(command);
      return path.resolve(command);
    } catch {
      return null;
    }
  }
  const pathValue = pathEnv ?? env.PATH ?? env.Path ?? "";
  const extensions =
    process.platform === "win32" ? (env.PATHEXT ?? ".EXE;.CMD;.BAT;.COM").split(";").filter(Boolean) : [""];
  for (const directory of pathValue.split(path.delimiter).filter(Boolean)) {
    for (const extension of extensions) {
      const candidate = path.join(directory, command + extension);
      try {
        await fs.access(candidate);
        return candidate;
      } catch {
        // try next
      }
    }
  }
  return null;
}

/**
 * Run a short probe process with a hard timeout. On timeout, signals the
 * direct child (probes stay non-detached for reliable SIGTERM). Callers must
 * extract only machine-readable fields from stdout/stderr and must not persist
 * credentials, prompts, Issue bodies, or model response bodies in diagnostics.
 */
export function runProcess(
  command,
  args,
  {
    timeoutMs = DEFAULT_PROBE_TIMEOUT_MS,
    env = process.env,
    cwd,
    input,
    killSignal = "SIGTERM",
  } = {},
) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
    return Promise.reject(new Error("invalid-timeout-ms"));
  }
  return new Promise((resolve) => {
    let timedOut = false;
    let settled = false;
    // Probes stay in the parent's process group so SIGTERM/SIGKILL reach the
    // CLI reliably; worker launches use spawnWorker (detached) instead.
    const child = spawn(command, args, {
      env,
      cwd,
      stdio: input === undefined ? ["ignore", "pipe", "pipe"] : ["pipe", "pipe", "pipe"],
    });
    const stdoutChunks = [];
    const stderrChunks = [];
    child.stdout?.on("data", (chunk) => stdoutChunks.push(chunk));
    child.stderr?.on("data", (chunk) => stderrChunks.push(chunk));
    if (input !== undefined && child.stdin) {
      child.stdin.end(input);
    }

    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };

    const killTree = (signal) => {
      if (!child.pid) return;
      try {
        if (process.platform === "win32") {
          spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"]);
        } else {
          child.kill(signal);
        }
      } catch {
        // already exited
      }
    };

    const timer = setTimeout(() => {
      timedOut = true;
      killTree(killSignal);
      // Escalate to SIGKILL, then force-resolve so a stuck child cannot hang the probe.
      setTimeout(() => {
        killTree("SIGKILL");
        finish({
          code: null,
          signal: "SIGKILL",
          timedOut: true,
          error: "verification-timeout",
          stdout: Buffer.concat(stdoutChunks).toString("utf8"),
          stderr: Buffer.concat(stderrChunks).toString("utf8"),
          pid: child.pid ?? null,
        });
      }, 500).unref?.();
    }, timeoutMs);

    child.on("error", (error) => {
      finish({
        code: null,
        signal: null,
        timedOut,
        error: error.code ?? error.message,
        stdout: Buffer.concat(stdoutChunks).toString("utf8"),
        stderr: Buffer.concat(stderrChunks).toString("utf8"),
        pid: child.pid ?? null,
      });
    });

    child.on("close", (code, signal) => {
      finish({
        code,
        signal,
        timedOut,
        error: null,
        stdout: Buffer.concat(stdoutChunks).toString("utf8"),
        stderr: Buffer.concat(stderrChunks).toString("utf8"),
        pid: child.pid ?? null,
      });
    });
  });
}

/**
 * Verify that a CLI can actually complete a minimal tool-use task headlessly
 * (no TTY, no human present) rather than merely answering an auth/model-list
 * check. Spawns the CLI in a throwaway sandbox directory with a fixed,
 * generated task ("create this exact file with this exact marker") and
 * classifies the result with a closed reason code. Never persists the
 * prompt text, stdout, stderr, or the marker itself — only the pass/fail
 * verdict and (on failure) a reason code leave this function.
 *
 * @param {object} options
 * @param {string} options.cliPath - resolved absolute path to the CLI.
 * @param {string[]} options.args - selector args (model flags etc.) to place
 *   before the generated task prompt; must not include the prompt itself.
 * @returns {Promise<{ok: true} | {ok: false, reason: string}>}
 */
export async function runHeadlessExecProbe({
  cliPath,
  args = [],
  run = runProcess,
  timeoutMs = DEFAULT_HEADLESS_PROBE_TIMEOUT_MS,
  env = process.env,
} = {}) {
  const sandboxDir = await fs.mkdtemp(path.join(os.tmpdir(), "soroeru-headless-probe-"));
  try {
    const marker = randomBytes(8).toString("hex");
    const artifactPath = path.join(sandboxDir, "probe.txt");
    const prompt = [
      `Create a new file at this exact path: ${artifactPath}`,
      `The file must contain exactly this text and nothing else: ${marker}`,
      "Do not modify or create any other file. Do not ask questions. Do not explain your steps.",
    ].join("\n");

    const result = await run(cliPath, [...args, prompt], { timeoutMs, env, cwd: sandboxDir });

    let artifactMatches = false;
    try {
      artifactMatches = (await fs.readFile(artifactPath, "utf8")).trim() === marker;
    } catch {
      artifactMatches = false;
    }
    if (artifactMatches) return { ok: true };
    if (result.timedOut) return { ok: false, reason: REASON_CODES.VERIFICATION_TIMEOUT };
    const combinedOutput = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
    if (TTY_REQUIRED_PATTERN.test(combinedOutput)) return { ok: false, reason: REASON_CODES.TTY_REQUIRED };
    // Exited cleanly but produced no artifact: a print/response-only mode
    // that never actually exercised a tool (observed for `agy --print`).
    if (result.code === 0) return { ok: false, reason: REASON_CODES.NON_AGENTIC_PRINT_MODE };
    return { ok: false, reason: REASON_CODES.HEADLESS_EXEC_FAILED };
  } finally {
    await fs.rm(sandboxDir, { recursive: true, force: true }).catch(() => {});
  }
}

/**
 * Quote a selector argument when it contains whitespace.
 * Returns null when the value cannot be represented safely (e.g. embedded quotes).
 */
export function quoteSelectorArg(value) {
  const text = String(value ?? "");
  if (!text || /["']/.test(text)) return null;
  if (/\s/.test(text)) return `"${text}"`;
  return text;
}

/** Split a selector string into argv tokens; supports simple double quotes. */
export function splitSelector(selector) {
  if (typeof selector !== "string" || !selector.trim()) {
    throw new Error("invalid-selector");
  }
  const tokens = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let match;
  while ((match = re.exec(selector)) !== null) {
    tokens.push(match[1] ?? match[2] ?? match[3]);
  }
  if (!tokens.length) throw new Error("invalid-selector");
  return tokens;
}

export function capabilityRecord({
  agent,
  requestedModel,
  model,
  role,
  selector,
  timeoutMs = DEFAULT_WORKER_TIMEOUT_MS,
  selectable = true,
  verifiable = true,
}) {
  const record = {
    agent,
    model,
    role,
    selector,
    selectable,
    verifiable,
    timeoutMs,
  };
  if (requestedModel !== undefined) record.requestedModel = requestedModel;
  return record;
}

export function diagnostic({ agent, status, reason, model } = {}) {
  const entry = { agent, status };
  if (reason !== undefined) entry.reason = reason;
  if (model !== undefined) entry.model = model;
  return entry;
}

/**
 * Best-effort `<cli> --version` read for cache-freshness comparison only.
 * Never throws; returns null on any failure so a version check never blocks
 * discovery. Output is a short version string, not prompt/response content.
 */
export async function readCliVersion(cliPath, { run = runProcess, timeoutMs = 10_000, env = process.env } = {}) {
  try {
    const result = await run(cliPath, ["--version"], { timeoutMs, env });
    if (result.timedOut || result.code !== 0) return null;
    const text = String(result.stdout ?? "").trim();
    return text || null;
  } catch {
    return null;
  }
}

/**
 * Returns the current HEAD commit SHA.
 */
export async function getRepositoryCommit(cwd) {
  try {
    const result = await runProcess("git", ["rev-parse", "HEAD"], { cwd });
    if (result.code !== 0) return null;
    return String(result.stdout ?? "").trim() || null;
  } catch {
    return null;
  }
}

/**
 * Verify that the repository checkout is not stale compared to origin/main.
 * Throws if fetch fails or if HEAD does not contain origin/main.
 */
export async function verifyRepositoryFreshness(cwd) {
  const fetchResult = await runProcess("git", ["fetch", "origin", "main"], { cwd });
  if (fetchResult.code !== 0) {
    throw new Error("orchestrator-checkout-stale:fetch-failed");
  }

  const mergeBaseResult = await runProcess("git", ["merge-base", "--is-ancestor", "origin/main", "HEAD"], { cwd });
  if (mergeBaseResult.code !== 0) {
    const headResult = await runProcess("git", ["rev-parse", "HEAD"], { cwd });
    const originMainResult = await runProcess("git", ["rev-parse", "origin/main"], { cwd });
    const headSha = String(headResult.stdout ?? "").trim() || "unknown";
    const originMainSha = String(originMainResult.stdout ?? "").trim() || "unknown";
    throw new Error(`orchestrator-checkout-stale:head=${headSha},origin/main=${originMainSha}`);
  }
}

/** Write JSON atomically so partial output is never a successful result. */
export async function writeJsonAtomic(filePath, value) {
  const absolute = path.resolve(filePath);
  await fs.mkdir(path.dirname(absolute), { recursive: true });
  const tempPath = `${absolute}.tmp.${process.pid}.${Date.now()}`;
  const payload = `${JSON.stringify(value, null, 2)}\n`;
  try {
    await fs.writeFile(tempPath, payload, "utf8");
    await fs.rename(tempPath, absolute);
  } catch (error) {
    try {
      await fs.unlink(tempPath);
    } catch {
      // ignore cleanup failures
    }
    throw error;
  }
  return absolute;
}

/**
 * Spawn a long-running worker and return a handle that can kill only that
 * process tree. Does not capture or persist stdout/stderr to run state.
 */
export function spawnWorker(command, args, { timeoutMs, env = process.env, cwd } = {}) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
    throw new Error("invalid-timeout-ms");
  }
  const child = spawn(command, args, {
    env,
    cwd,
    stdio: ["ignore", "pipe", "pipe"],
    detached: process.platform !== "win32",
  });
  // Drain pipes so the child cannot block on a full buffer; discard contents.
  child.stdout?.on("data", () => {});
  child.stderr?.on("data", () => {});

  let timedOut = false;
  let exitResult;
  const killTree = (signal = "SIGTERM") => {
    if (!child.pid) return;
    try {
      if (process.platform === "win32") {
        spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"]);
      } else {
        process.kill(-child.pid, signal);
      }
    } catch {
      try {
        child.kill(signal);
      } catch {
        // already exited
      }
    }
  };

  const timer = setTimeout(() => {
    timedOut = true;
    killTree("SIGTERM");
    setTimeout(() => killTree("SIGKILL"), 1_000).unref?.();
  }, timeoutMs);

  // Register close/error once at spawn so late wait() callers still resolve.
  const done = new Promise((resolve) => {
    const finish = (result) => {
      if (exitResult) return;
      clearTimeout(timer);
      exitResult = result;
      resolve(result);
    };
    child.on("close", (code, signal) => {
      finish({ code, signal, timedOut, pid: child.pid });
    });
    child.on("error", () => {
      finish({ code: null, signal: null, timedOut, pid: child.pid, error: true });
    });
  });

  return {
    pid: child.pid,
    kill: killTree,
    wait: () => done,
    get timedOut() {
      return timedOut;
    },
  };
}

/** Build the minimal worker prompt — Issue number and route labels only. */
export function buildWorkerPrompt({ issueNumber, agent, model, releasePolicy, nextMilestone }) {
  return [
    "Implement exactly one GitHub Issue using the repository issue-implementation (or handoff-issue) skill.",
    `Issue: #${issueNumber}`,
    `Assigned route: agent=${agent} model=${model}`,
    `Release policy: ${releasePolicy}`,
    `Next milestone: ${nextMilestone}`,
    "Do not store credentials, Issue bodies, prompts, diffs, or model response bodies in orchestrator run state.",
  ].join("\n");
}
