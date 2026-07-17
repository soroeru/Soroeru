import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";

/** Closed diagnostic reason codes (no free-form secrets). */
export const REASON_CODES = Object.freeze({
  CLI_NOT_FOUND: "cli-not-found",
  AUTH_UNAVAILABLE: "auth-unavailable",
  MODEL_NOT_SELECTABLE: "model-not-selectable",
  MODEL_MISMATCH: "model-mismatch",
  VERIFICATION_TIMEOUT: "verification-timeout",
  PROBE_FAILED: "probe-failed",
});

export const DEFAULT_PROBE_TIMEOUT_MS = 30_000;
export const DEFAULT_WORKER_TIMEOUT_MS = 3_600_000;

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
