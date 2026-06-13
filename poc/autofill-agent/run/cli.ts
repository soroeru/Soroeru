// PoC CLI. Commands:
//   serve [port]                       — start the 10-pattern test-site server
//   matrix [variant] [engines]        — run measurements (variant: deterministic | ai | both)
//   register <siteId> [variant]      — headed demo run with the interactive CLI gate
//   app                                — app-shell lifecycle smoke test (unlock/browser/lock)
//   ui [variant]                       — interactive local app UI (personal data, sites, settings, ...)
//
// Examples:
//   node dist/compiled/poc/autofill-agent/run/cli.js serve 4333
//   node dist/compiled/poc/autofill-agent/run/cli.js matrix deterministic chromium,firefox,webkit
//   node dist/compiled/poc/autofill-agent/run/cli.js register 08-terms
//   node dist/compiled/poc/autofill-agent/run/cli.js app
//   node dist/compiled/poc/autofill-agent/run/cli.js ui

import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { startPocServer } from "../sites/server.js";
import { AiMapper } from "../src/agent/ai/ai-mapper.js";
import { aiProviderFromEnv, createProvider } from "../src/agent/ai/provider.js";
import { CliGate } from "../src/agent/gate.js";
import { DeterministicMapper, type Mapper } from "../src/agent/mapper.js";
import { DUMMY_PROFILE_SEED } from "../src/profile.js";
import { AutofillApp, AutofillAppError } from "../src/app/app.js";
import { AppRunner } from "../src/app/runner.js";
import { askSecret, AppUI } from "../src/app/ui.js";
import { formatResult, runDemo, runVariant, type EngineName, type VariantRunResult } from "./measure.js";

const STATE_ROOT = "state/autofill-poc";

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
    await writeFile(out, JSON.stringify(results, null, 2), "utf8");
    console.log(`\n詳細結果: ${out}`);
  }
}

async function cmdRegister(siteId: string, variantArg: string): Promise<void> {
  const server = await startPocServer();
  const app = new AutofillApp({ stateDir: join(STATE_ROOT, "manual") });
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
  const app = new AutofillApp({ stateDir: join(STATE_ROOT, "app") });
  try {
    await app.unlock(process.env["AF_POC_PASSPHRASE"] ?? "poc-dummy-passphrase");
  } catch (err) {
    if (err instanceof AutofillAppError) {
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
function aiMapperForUi(app: AutofillApp): Mapper {
  const settings = app.store.getSettings();
  const provider = settings ? createProvider(settings) : aiProviderFromEnv();
  if (!provider) {
    throw new Error(
      "AI版を使うには「5. 設定」でAIプロバイダを登録するか、OPENAI_API_KEY / ANTHROPIC_API_KEY を設定してください",
    );
  }
  return new AiMapper(provider);
}

async function cmdUi(variantArg: string): Promise<void> {
  const server = await startPocServer();
  const app = new AutofillApp({ stateDir: join(STATE_ROOT, "manual") });
  try {
    const passphrase = process.env["AF_POC_PASSPHRASE"] ?? (await askSecret("マスターパスフレーズ: "));
    try {
      await app.unlock(passphrase);
    } catch (err) {
      if (err instanceof AutofillAppError) {
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
    await cmdUi(arg1 ?? "deterministic");
    break;
  default:
    console.log(
      "usage: cli.js serve [port] | matrix [deterministic|ai|both] [engines] | register <siteId> [variant] | demo [deterministic|ai] [engine] | app | ui [deterministic|ai]",
    );
}
