// PoC CLI. Commands:
//   serve [port]                       — start the 10-pattern test-site server
//   matrix [variant] [engines]        — run measurements (variant: deterministic | ai | both)
//   register <siteId> [variant]      — headed demo run with the interactive CLI gate
//   app                                — app-shell lifecycle smoke test (unlock/browser/lock)
//   ui [variant] [port]                — local browser app UI (personal data, sites, settings, ...)
//   ui:cli [variant]                   — legacy interactive terminal UI
//   check-egress                       — PRIV-001 static network-egress allowlist check
//   check-persistence                  — PRIV-002 static local-persistence allowlist check
//   check-bypass                       — SEC-002 static CAPTCHA/anti-bot-evasion dependency denylist check
//
// Examples:
//   node dist/compiled/run/cli.js serve 4333
//   node dist/compiled/run/cli.js matrix deterministic chromium,firefox,webkit
//   node dist/compiled/run/cli.js register 08-terms
//   node dist/compiled/run/cli.js app
//   node dist/compiled/run/cli.js ui
//   node dist/compiled/run/cli.js ui:cli
//   node dist/compiled/run/cli.js check-egress
//   node dist/compiled/run/cli.js check-persistence
//   node dist/compiled/run/cli.js check-bypass

import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { startPocServer } from "../sites/server.js";
import { AiMapper } from "../src/agent/ai/ai-mapper.js";
import { aiProviderFromEnv, createProvider } from "../src/agent/ai/provider.js";
import { CliGate } from "../src/agent/gate.js";
import { DeterministicMapper, type Mapper } from "../src/agent/mapper.js";
import { DUMMY_PROFILE_SEED } from "../src/profile.js";
import { SoroeruApp, SoroeruAppError } from "../src/app/app.js";
import { AppRunner } from "../src/app/runner.js";
import { askSecret, AppUI } from "../src/app/ui.js";
import { startWebUiServer, type WebUiServerHandle } from "../src/app/web-ui.js";
import { defaultVaultStateDir } from "../src/store/vault.js";
import { checkBypassDenylist } from "../src/dev/bypass-check.js";
import { SCAN_DIRS as EGRESS_SCAN_DIRS, checkNetworkEgress } from "../src/dev/egress-check.js";
import {
  ALLOWED_PERSIST_CATEGORIES,
  SCAN_DIRS as PERSIST_SCAN_DIRS,
  checkLocalPersistence,
} from "../src/dev/privacy-check.js";
import { formatResult, hasFailures, runDemo, runVariant, type EngineName, type VariantRunResult } from "./measure.js";

const STATE_ROOT = defaultVaultStateDir({
  appBundle: process.env["SOROERU_APP_BUNDLE"] === "1",
  ...(process.env["SOROERU_STATE_ROOT"] ? { override: process.env["SOROERU_STATE_ROOT"] } : {}),
});

function openUrlInDefaultBrowser(url: string): void {
  if (process.platform !== "darwin") return;
  const child = spawn("open", [url], { detached: true, stdio: "ignore" });
  child.unref();
}

function aiMapperFromEnv(): Mapper | undefined {
  const provider = aiProviderFromEnv();
  return provider ? new AiMapper(provider) : undefined;
}

function mapperFor(variantArg: string): Mapper {
  if (variantArg === "ai") {
    const ai = aiMapperFromEnv();
    if (!ai) throw new Error("AI版を使うには OPENAI_API_KEY または ANTHROPIC_API_KEY を設定してください（.env も可）");
    return ai;
  }
  return new DeterministicMapper();
}

const ENGINE_NAMES: EngineName[] = ["chromium", "firefox", "webkit"];

async function cmdDemo(variantArg: string, engineArg: string): Promise<void> {
  const engine = (engineArg || "chromium") as EngineName;
  if (!ENGINE_NAMES.includes(engine)) {
    throw new Error(`unknown engine "${engineArg}" (use one of: ${ENGINE_NAMES.join(", ")})`);
  }
  await runDemo(mapperFor(variantArg), engine, STATE_ROOT, (m) => console.log(m));
}

async function cmdServe(port: number): Promise<void> {
  const server = await startPocServer(port);
  console.log(`PoC test sites: ${server.url}/`);
}

async function cmdMatrix(variantArg: string, enginesArg: string): Promise<void> {
  const engines = enginesArg.split(",").filter(Boolean) as EngineName[];
  const results: VariantRunResult[] = [];
  const log = (m: string): void => console.log(m);

  if (variantArg === "deterministic" || variantArg === "both") {
    for (const engine of engines) {
      results.push(await runVariant(new DeterministicMapper(), engine, STATE_ROOT, log));
    }
  }
  if (variantArg === "ai" || variantArg === "both") {
    const ai = aiMapperFromEnv();
    if (!ai) {
      console.log("\nAI版はスキップ: OPENAI_API_KEY / ANTHROPIC_API_KEY が未設定です（ユーザー契約のAIプロバイダのキーを設定して再実行してください）。");
    } else {
      // The AI variant measures mapping accuracy; engine coverage is the
      // deterministic run's job, so the AI run uses chromium only.
      results.push(await runVariant(ai, "chromium", STATE_ROOT, log));
    }
  }

  for (const result of results) console.log(formatResult(result));

  if (results.length > 0) {
    console.log("\n== 比較表（新規登録成功率 / 誤マッピング率） ==");
    console.log("| variant | engine | success rate | mis-mapping rate |");
    console.log("| --- | --- | --- | --- |");
    for (const r of results) {
      console.log(
        `| ${r.variant} | ${r.engine} | ${(r.successRate * 100).toFixed(0)}% | ${(r.misMappingRate * 100).toFixed(1)}% |`,
      );
    }
    await mkdir(STATE_ROOT, { recursive: true });
    const out = join(STATE_ROOT, `matrix-${Date.now()}.json`);
    // persist: measurement-output — notes are masked via maskForArtifact (docs/security.md §3)
    await writeFile(out, JSON.stringify(results, null, 2), "utf8");
    console.log(`\n詳細結果: ${out}`);
  }

  // TEST-001 (#45): fail the command (and CI) if any variant/engine hit a
  // safety-critical regression (registration, guards, bulk update, wall
  // detection/resume, or the trial-card decline path).
  if (results.some((r) => hasFailures(r))) {
    console.error("\nNG: 上記いずれかの結果が安全性に関わる検証に失敗しました（詳細は各行の note を参照）。");
    process.exitCode = 1;
  }
}

async function cmdRegister(siteId: string, variantArg: string): Promise<void> {
  const server = await startPocServer();
  const app = new SoroeruApp({ stateDir: join(STATE_ROOT, "manual") });
  try {
    await app.unlock(process.env["AF_POC_PASSPHRASE"] ?? "poc-dummy-passphrase");
    for (const seed of DUMMY_PROFILE_SEED) {
      if (!app.store.profile.has(seed.key)) app.store.setProfileValue(seed.key, seed.label, seed.value);
    }
    const mapper = mapperFor(variantArg);
    const browser = await app.launchBrowser("chromium");
    const page = await browser.newPage();
    const runner = new AppRunner(app, mapper);
    const result = await runner.register(page, server.siteUrl(siteId), {
      gate: new CliGate(),
      promptUser: async (label) => {
        const { createInterface } = await import("node:readline/promises");
        const rl = createInterface({ input: process.stdin, output: process.stdout });
        try {
          return await rl.question(`未保存の項目「${label}」の値を入力してください: `);
        } finally {
          rl.close();
        }
      },
      log: (m) => console.log(m),
    });
    console.log(`\nstatus: ${result.status}`);
    for (const note of result.notes) console.log(`note: ${note}`);
  } finally {
    await app.shutdown();
    await server.close();
  }
}

async function cmdApp(): Promise<void> {
  const app = new SoroeruApp({ stateDir: join(STATE_ROOT, "app") });
  try {
    await app.unlock(process.env["AF_POC_PASSPHRASE"] ?? "poc-dummy-passphrase");
  } catch (err) {
    if (err instanceof SoroeruAppError) {
      console.error(`store unlock failed: ${err.message}`);
      return;
    }
    throw err;
  }
  console.log(`store unlocked: ${app.storeFilePath}`);
  try {
    const browser = await app.launchBrowser("chromium");
    console.log("browser launched (chromium)");
    const page = await browser.newPage();
    await page.goto("about:blank");
    console.log("navigated to about:blank");
  } finally {
    await app.shutdown();
    console.log("browser closed, store locked");
  }
}

/**
 * Build the AI mapper for the interactive UI: prefer the provider the user
 * configured via Settings (encrypted store), falling back to environment
 * variables (REQ-012) for users who have not opened Settings yet.
 */
function aiMapperForUi(app: SoroeruApp): Mapper {
  const settings = app.store.getSettings();
  const provider = settings ? createProvider(settings) : aiProviderFromEnv();
  if (!provider) {
    throw new Error(
      "AI版を使うには「5. 設定」でAIプロバイダを登録するか、OPENAI_API_KEY / ANTHROPIC_API_KEY を設定してください",
    );
  }
  return new AiMapper(provider, app.store);
}

/** PRIV-001 (#20): fail if a network-call site is unannotated or a telemetry dependency was added. */
function cmdCheckEgress(): void {
  const result = checkNetworkEgress(process.cwd());
  console.log(`network egress check: ${result.scannedFiles} file(s) scanned under ${EGRESS_SCAN_DIRS.map((dir) => `${dir}/`).join(", ")}`);
  if (result.violations.length > 0) {
    console.error("violations (see docs/security.md §6):");
    for (const v of result.violations) console.error(`  - ${v}`);
    process.exitCode = 1;
    return;
  }
  console.log("ok: every network call is annotated (target-site / ai-provider); no telemetry/analytics dependency found");
}

/** PRIV-002 (#21): fail if a local-write site bypasses the encrypted storage abstraction unannotated. */
function cmdCheckPersistence(): void {
  const result = checkLocalPersistence(process.cwd());
  console.log(`local persistence check: ${result.scannedFiles} file(s) scanned under ${PERSIST_SCAN_DIRS.map((dir) => `${dir}/`).join(", ")}`);
  if (result.violations.length > 0) {
    console.error("violations (see docs/security.md §3):");
    for (const v of result.violations) console.error(`  - ${v}`);
    process.exitCode = 1;
    return;
  }
  console.log(`ok: every local write is annotated (${[...ALLOWED_PERSIST_CATEGORIES].join(" / ")})`);
}

/** SEC-002 (#23): fail if package.json gained a CAPTCHA-solving / anti-bot-evasion dependency. */
function cmdCheckBypass(): void {
  const result = checkBypassDenylist(process.cwd());
  if (result.violations.length > 0) {
    console.error("violations (see docs/security.md §7):");
    for (const v of result.violations) console.error(`  - ${v}`);
    process.exitCode = 1;
    return;
  }
  console.log("ok: no CAPTCHA-solving / anti-bot / fingerprint-evasion dependency found");
}

async function cmdCliUi(variantArg: string): Promise<void> {
  const server = await startPocServer();
  const app = new SoroeruApp({ stateDir: join(STATE_ROOT, "manual") });
  try {
    const passphrase = process.env["AF_POC_PASSPHRASE"] ?? (await askSecret("マスターパスフレーズ: "));
    try {
      await app.unlock(passphrase);
    } catch (err) {
      if (err instanceof SoroeruAppError) {
        console.error(err.message);
        return;
      }
      throw err;
    }
    for (const seed of DUMMY_PROFILE_SEED) {
      if (!app.store.profile.has(seed.key)) app.store.setProfileValue(seed.key, seed.label, seed.value);
    }
    const mapper = variantArg === "ai" ? aiMapperForUi(app) : new DeterministicMapper();
    const runner = new AppRunner(app, mapper);
    const ui = new AppUI(app, runner);
    await ui.run();
  } finally {
    await app.shutdown();
    await server.close();
  }
}

async function cmdWebUi(variantArg: string, portArg: string | undefined): Promise<void> {
  const parsedPort = portArg === undefined ? undefined : Number(portArg);
  if (parsedPort !== undefined && (!Number.isInteger(parsedPort) || parsedPort < 0 || parsedPort > 65535)) {
    throw new Error("port must be an integer between 0 and 65535");
  }
  const app = new SoroeruApp({ stateDir: join(STATE_ROOT, "manual") });

  let shuttingDown = false;
  let serverHandle: WebUiServerHandle | undefined;
  const shutdown = async (): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    await app.shutdown();
    await serverHandle?.close();
    process.exit(0);
  };

  const server = await startWebUiServer({
    app,
    ...(parsedPort !== undefined ? { port: parsedPort } : {}),
    log: (message) => console.error(message),
    // Lazy: called after the store is unlocked, so the "ai" variant can read
    // the user's configured provider from `app.store.getSettings()`.
    mapperFactory: variantArg === "ai" ? () => aiMapperForUi(app) : () => new DeterministicMapper(),
    onShutdownRequest: () => { void shutdown(); },
  });
  serverHandle = server;
  console.log(`Soroeru local web app: ${server.url}`);
  console.log(`mapper variant: ${variantArg}`);
  console.log("Press Ctrl+C to stop.");
  if (process.env["SOROERU_OPEN_BROWSER"] === "1") openUrlInDefaultBrowser(server.url);

  process.once("SIGINT", () => {
    void shutdown();
  });
  process.once("SIGTERM", () => {
    void shutdown();
  });
  await new Promise<void>(() => {
    // Keep the local UI process alive until a signal triggers shutdown.
  });
}

const [, , command, arg1, arg2] = process.argv;
switch (command) {
  case "serve":
    await cmdServe(Number(arg1 ?? 4333));
    break;
  case "matrix":
    await cmdMatrix(arg1 ?? "deterministic", arg2 ?? "chromium,firefox,webkit");
    break;
  case "register":
    if (!arg1) throw new Error("usage: register <siteId> [deterministic|ai]");
    await cmdRegister(arg1, arg2 ?? "deterministic");
    break;
  case "demo":
    // Headed, auto-approved run across all 10 sites. Default variant: ai.
    await cmdDemo(arg1 ?? "ai", arg2 ?? "chromium");
    break;
  case "app":
    await cmdApp();
    break;
  case "ui":
    await cmdWebUi(arg1 ?? "deterministic", arg2);
    break;
  case "ui:cli":
    await cmdCliUi(arg1 ?? "deterministic");
    break;
  case "check-egress":
    cmdCheckEgress();
    break;
  case "check-persistence":
    cmdCheckPersistence();
    break;
  case "check-bypass":
    cmdCheckBypass();
    break;
  default:
    console.log(
      "usage: cli.js serve [port] | matrix [deterministic|ai|both] [engines] | register <siteId> [variant] | demo [deterministic|ai] [engine] | app | ui [deterministic|ai] [port] | ui:cli [deterministic|ai] | check-egress | check-persistence | check-bypass",
    );
}
