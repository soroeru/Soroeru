// PoC CLI. Commands:
//   serve [port]                       — start the 10-pattern test-site server
//   matrix [variant] [engines]        — run measurements (variant: deterministic | ai | both)
//   register <siteId> [variant]      — headed demo run with the interactive CLI gate
//
// Examples:
//   node dist/compiled/poc/autofill-agent/run/cli.js serve 4333
//   node dist/compiled/poc/autofill-agent/run/cli.js matrix deterministic chromium,firefox,webkit
//   node dist/compiled/poc/autofill-agent/run/cli.js register 08-terms

import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { chromium } from "playwright";
import { startPocServer } from "../sites/server.js";
import { runRegistration } from "../src/agent/agent.js";
import { AiMapper } from "../src/agent/ai/ai-mapper.js";
import { aiProviderFromEnv } from "../src/agent/ai/provider.js";
import { CliGate } from "../src/agent/gate.js";
import { DeterministicMapper, type Mapper } from "../src/agent/mapper.js";
import { DUMMY_PROFILE_SEED } from "../src/profile.js";
import { PocStore } from "../src/store/store.js";
import { formatResult, runVariant, type EngineName, type VariantRunResult } from "./measure.js";

const STATE_ROOT = "state/autofill-poc";

function aiMapperFromEnv(): Mapper | undefined {
  const provider = aiProviderFromEnv();
  return provider ? new AiMapper(provider) : undefined;
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
      console.log("\nAI版はスキップ: ANTHROPIC_API_KEY が未設定です（ユーザー契約のAIプロバイダのキーを設定して再実行してください）。");
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
  const browser = await chromium.launch({ headless: false });
  try {
    const store = await PocStore.open(
      join(STATE_ROOT, "manual", "store.json"),
      process.env["AF_POC_PASSPHRASE"] ?? "poc-dummy-passphrase",
    );
    for (const seed of DUMMY_PROFILE_SEED) {
      if (!store.profile.has(seed.key)) store.setProfileValue(seed.key, seed.label, seed.value);
    }
    const mapper = variantArg === "ai" ? aiMapperFromEnv() : new DeterministicMapper();
    if (!mapper) throw new Error("AI版を使うには ANTHROPIC_API_KEY を設定してください");
    const page = await browser.newPage();
    const result = await runRegistration(page, server.siteUrl(siteId), {
      store,
      mapper,
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
    await browser.close();
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
  default:
    console.log("usage: cli.js serve [port] | matrix [deterministic|ai|both] [engines] | register <siteId> [variant]");
}
