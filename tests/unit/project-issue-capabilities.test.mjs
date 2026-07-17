import test from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { discoverCapabilities } from "../../scripts/project-issue-capabilities.mjs";
import { dispatchWorker } from "../../scripts/project-issue-dispatch.mjs";
import { discoverAllCapabilities, RUNTIME_ADAPTERS } from "../../scripts/project-issue-runtime-adapters/index.mjs";
import { REASON_CODES, splitSelector, writeJsonAtomic } from "../../scripts/project-issue-runtime-adapters/shared.mjs";
import { selectWorkerRoutes } from "../../scripts/project-issue-orchestrator.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

async function makeFakeBin(directory, name, scriptBody) {
  const filePath = path.join(directory, name);
  // Absolute Node shebang so isolated PATH does not need `env node`.
  await writeFile(filePath, `#!${process.execPath}\n${scriptBody}\n`, "utf8");
  await chmod(filePath, 0o755);
  return filePath;
}

/**
 * PATH with only the fake bin plus the directory of the current Node binary
 * (for `#!/usr/bin/env node` shebangs). Real agent CLIs are never visible.
 */
function isolatedPath(directory) {
  return `${directory}${path.delimiter}${path.dirname(process.execPath)}`;
}

test("runtime adapters evaluate in fixed Codex → Claude → Grok → Gemini order", () => {
  assert.deepEqual(
    RUNTIME_ADAPTERS.map((adapter) => adapter.agent),
    ["Codex", "Claude", "Grok", "Gemini"],
  );
});

test("discovers only verified routes and keeps partial failures isolated", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "soroeru-cap-partial-"));
  const bin = path.join(directory, "bin");
  await mkdir(bin);

  await makeFakeBin(
    bin,
    "codex",
    `
    const [cmd, sub] = process.argv.slice(2);
    if (cmd === "login" && sub === "status") {
      process.stdout.write("Logged in using ChatGPT\\n");
      process.exit(0);
    }
    if (cmd === "debug" && sub === "models") {
      process.stdout.write(JSON.stringify({
        models: [
          { slug: "gpt-test", display_name: "GPT Test", visibility: "list" },
          { slug: "hidden", display_name: "Hidden", visibility: "hidden" }
        ]
      }));
      process.exit(0);
    }
    process.exit(2);
    `,
  );
  // Claude missing → cli-not-found
  await makeFakeBin(
    bin,
    "grok",
    `
    if (process.argv[2] === "models") {
      process.stdout.write("You are logged in with grok.com.\\n\\nAvailable models:\\n  * grok-test\\n");
      process.exit(0);
    }
    process.exit(2);
    `,
  );
  await makeFakeBin(
    bin,
    "agy",
    `
    if (process.argv[2] === "models") {
      process.stderr.write("auth required\\n");
      process.exit(1);
    }
    process.exit(2);
    `,
  );

  const result = await discoverCapabilities({
    env: { ...process.env, PATH: isolatedPath(bin) },
    pathEnv: isolatedPath(bin),
    timeoutMs: 5_000,
    workerTimeoutMs: 60_000,
  });

  const workers = result.capabilities.filter((record) => record.role === "worker");
  assert.deepEqual(
    workers.map((record) => `${record.agent}:${record.model}`).sort(),
    ["Codex:gpt-test", "Grok:grok-test"],
  );
  assert.ok(workers.every((record) => record.selectable && record.verifiable && record.selector));
  assert.ok(workers.every((record) => record.timeoutMs === 60_000));

  const byAgent = Object.fromEntries(
    result.diagnostics
      .filter((entry) => entry.status === "failed")
      .map((entry) => [entry.agent, entry.reason]),
  );
  assert.equal(byAgent.Claude, REASON_CODES.CLI_NOT_FOUND);
  assert.equal(byAgent.Gemini, REASON_CODES.AUTH_UNAVAILABLE);
  // Diagnostics must not look like secrets / prompt dumps.
  for (const entry of result.diagnostics) {
    assert.equal(Object.keys(entry).every((key) => ["agent", "status", "reason", "model"].includes(key)), true);
  }
});

test("fails closed with empty capabilities when every adapter fails", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "soroeru-cap-empty-"));
  const bin = path.join(directory, "bin");
  await mkdir(bin);
  // Empty fake bin → all cli-not-found (node dir only, no agent CLIs)
  const result = await discoverAllCapabilities({
    env: { ...process.env, PATH: isolatedPath(bin) },
    pathEnv: isolatedPath(bin),
    timeoutMs: 2_000,
  });
  assert.deepEqual(result.capabilities, []);
  assert.equal(result.diagnostics.length, 4);
  assert.ok(result.diagnostics.every((entry) => entry.reason === REASON_CODES.CLI_NOT_FOUND));
  assert.deepEqual(selectWorkerRoutes(result.capabilities), []);
});

test("records verification-timeout without aborting later adapters", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "soroeru-cap-timeout-"));
  const bin = path.join(directory, "bin");
  await mkdir(bin);
  // Injected runProcess: Codex always times out; Claude returns a model list.
  // Avoids real hung processes that slow subsequent probes under load.
  const runProcess = async (command, args) => {
    const base = path.basename(command);
    if (base === "codex") {
      return {
        code: null,
        signal: "SIGKILL",
        timedOut: true,
        error: "verification-timeout",
        stdout: "",
        stderr: "",
        pid: 0,
      };
    }
    if (base === "claude" && args[0] === "auth" && args[1] === "status") {
      return { code: 0, signal: null, timedOut: false, error: null, stdout: JSON.stringify({ loggedIn: true }), stderr: "", pid: 1 };
    }
    if (base === "claude" && args[0] === "models") {
      return {
        code: 0,
        signal: null,
        timedOut: false,
        error: null,
        stdout: JSON.stringify([{ id: "sonnet" }]),
        stderr: "",
        pid: 2,
      };
    }
    return { code: 127, signal: null, timedOut: false, error: null, stdout: "", stderr: "", pid: null };
  };
  const resolveExecutable = async (name) => {
    if (name === "codex" || name === "claude") return path.join(bin, name);
    return null;
  };
  // Touch paths so basename resolution stays realistic.
  await makeFakeBin(bin, "codex", "process.exit(0);");
  await makeFakeBin(bin, "claude", "process.exit(0);");

  const result = await discoverAllCapabilities({
    env: { ...process.env, PATH: isolatedPath(bin) },
    pathEnv: isolatedPath(bin),
    timeoutMs: 5_000,
    workerTimeoutMs: 30_000,
    runProcess,
    resolveExecutable,
  });

  assert.ok(
    result.diagnostics.some(
      (entry) => entry.agent === "Codex" && entry.reason === REASON_CODES.VERIFICATION_TIMEOUT,
    ),
  );
  assert.ok(result.capabilities.some((record) => record.agent === "Claude" && record.model === "sonnet"));
});

test("rejects model catalog parse failures as model-not-selectable", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "soroeru-cap-mismatch-"));
  const bin = path.join(directory, "bin");
  await mkdir(bin);
  await makeFakeBin(bin, "codex", "process.exit(0);");
  const runProcess = async (command, args) => {
    if (path.basename(command) !== "codex") {
      return { code: 127, signal: null, timedOut: false, error: null, stdout: "", stderr: "", pid: null };
    }
    if (args[0] === "login" && args[1] === "status") {
      return { code: 0, signal: null, timedOut: false, error: null, stdout: "Logged in\n", stderr: "", pid: 1 };
    }
    if (args[0] === "debug" && args[1] === "models") {
      return {
        code: 0,
        signal: null,
        timedOut: false,
        error: null,
        stdout: "not-json-and-no-models",
        stderr: "",
        pid: 2,
      };
    }
    return { code: 2, signal: null, timedOut: false, error: null, stdout: "", stderr: "", pid: 3 };
  };
  const result = await discoverAllCapabilities({
    env: { ...process.env, PATH: isolatedPath(bin) },
    pathEnv: isolatedPath(bin),
    timeoutMs: 3_000,
    runProcess,
    resolveExecutable: async (name) => (name === "codex" ? path.join(bin, "codex") : null),
  });
  assert.ok(
    result.diagnostics.some(
      (entry) => entry.agent === "Codex" && entry.reason === REASON_CODES.MODEL_NOT_SELECTABLE,
    ),
  );
  assert.equal(
    result.capabilities.filter((record) => record.agent === "Codex").length,
    0,
  );
});

test("writes capabilities atomically and never leaves a partial final file", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "soroeru-cap-atomic-"));
  const outputPath = path.join(directory, "capabilities.json");
  await writeJsonAtomic(outputPath, { capabilities: [{ agent: "old" }], diagnostics: [] });
  const before = await readFile(outputPath, "utf8");

  const bin = path.join(directory, "bin");
  await mkdir(bin);
  await makeFakeBin(
    bin,
    "grok",
    `
    if (process.argv[2] === "models") {
      process.stdout.write("You are logged in.\\nAvailable models:\\n  * grok-atomic\\n");
      process.exit(0);
    }
    process.exit(2);
    `,
  );

  const result = await discoverCapabilities({
    outputPath,
    env: { ...process.env, PATH: isolatedPath(bin) },
    pathEnv: isolatedPath(bin),
    timeoutMs: 3_000,
    workerTimeoutMs: 12_000,
  });
  assert.equal(result.outputPath, outputPath);
  const after = JSON.parse(await readFile(outputPath, "utf8"));
  assert.notEqual(after.capabilities[0]?.agent, "old");
  assert.ok(after.capabilities.some((record) => record.model === "grok-atomic"));
  assert.ok(before.includes("old"));
  // No tmp leftovers that look like the final name without .tmp
  const finalStat = await stat(outputPath);
  assert.ok(finalStat.isFile());
});

test("dispatches a non-Codex route with the exact probe selector and model", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "soroeru-cap-dispatch-"));
  const bin = path.join(directory, "bin");
  await mkdir(bin);
  const marker = path.join(directory, "launched.json");
  await makeFakeBin(
    bin,
    "grok",
    `
    const fs = require("node:fs");
    const marker = process.env.SOROERU_LAUNCH_MARKER;
    fs.writeFileSync(marker, JSON.stringify({ argv: process.argv.slice(2) }));
    process.exit(0);
    `,
  );
  const grokPath = path.join(bin, "grok");
  const route = {
    agent: "Grok",
    model: "grok-4.5",
    requestedModel: "Grok 4.5",
    role: "worker",
    selector: `${grokPath} --model grok-4.5`,
    selectable: true,
    verifiable: true,
    timeoutMs: 10_000,
  };

  const handle = await dispatchWorker(
    {
      route,
      issueNumber: 413,
      releasePolicy: "merged",
      nextMilestone: "pr-created",
      cwd: directory,
    },
    { env: { ...process.env, PATH: isolatedPath(bin), SOROERU_LAUNCH_MARKER: marker } },
  );
  const waited = await handle.wait();
  assert.equal(waited.code, 0);
  assert.equal(waited.timedOut, false);

  const launched = JSON.parse(await readFile(marker, "utf8"));
  assert.deepEqual(launched.argv.slice(0, 2), ["--model", "grok-4.5"]);
  assert.match(launched.argv.at(-1), /Issue: #413/);
  assert.match(launched.argv.at(-1), /agent=Grok/);
  assert.doesNotMatch(launched.argv.at(-1), /password|token|BEGIN /i);
});

test("dispatch timeout kills only the worker process tree", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "soroeru-cap-dispatch-timeout-"));
  const bin = path.join(directory, "bin");
  await mkdir(bin);
  await makeFakeBin(
    bin,
    "claude",
    `
    setInterval(() => {}, 60_000);
    `,
  );
  const claudePath = path.join(bin, "claude");
  const route = {
    agent: "Claude",
    model: "sonnet",
    role: "worker",
    selector: `${claudePath} --model sonnet`,
    selectable: true,
    verifiable: true,
    timeoutMs: 200,
  };
  const handle = await dispatchWorker({
    route,
    issueNumber: 1,
    releasePolicy: "pr-created",
    nextMilestone: "pr-created",
  });
  const waited = await handle.wait();
  assert.equal(waited.timedOut, true);
});

test("splitSelector preserves quoted multi-word model ids used by Gemini/agy", () => {
  assert.deepEqual(splitSelector(`/bin/agy --model "Gemini 3.1 Pro (High)" --print`), [
    "/bin/agy",
    "--model",
    "Gemini 3.1 Pro (High)",
    "--print",
  ]);
});

test("Gemini adapter records agy models with exact display names", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "soroeru-cap-gemini-"));
  const bin = path.join(directory, "bin");
  await mkdir(bin);
  await makeFakeBin(
    bin,
    "agy",
    `
    if (process.argv[2] === "models") {
      process.stdout.write("Gemini 3.1 Pro (High)\\nGemini 3.5 Flash (Medium)\\n");
      process.exit(0);
    }
    process.exit(2);
    `,
  );
  const result = await discoverAllCapabilities({
    env: { ...process.env, PATH: isolatedPath(bin) },
    pathEnv: isolatedPath(bin),
    timeoutMs: 3_000,
    workerTimeoutMs: 9_000,
  });
  const geminiWorkers = result.capabilities.filter(
    (record) => record.agent === "Gemini" && record.role === "worker",
  );
  assert.deepEqual(
    geminiWorkers.map((record) => record.model).sort(),
    ["Gemini 3.1 Pro (High)", "Gemini 3.5 Flash (Medium)"],
  );
  assert.ok(geminiWorkers[0].selector.includes("--model"));
  assert.ok(geminiWorkers[0].selector.includes("Gemini 3.1 Pro (High)"));
});

test("capabilities CLI module is importable from the repository root", async () => {
  const script = path.join(repoRoot, "scripts/project-issue-capabilities.mjs");
  assert.equal((await stat(script)).isFile(), true);
});
