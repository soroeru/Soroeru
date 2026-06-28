import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { DomainService } from "../../src/domain/domain-service.js";
import { importPasswordCsv } from "../../src/domain/csv-import.js";
import { VaultV2 } from "../../src/store/vault-v2.js";
import { BrowserEngine } from "../../src/automation/browser-engine.js";
import { VisibilityRunner } from "../../src/automation/visibility-runner.js";

const PASSPHRASE = "local-real-visibility-e2e-passphrase";
const DEFAULT_CSV = "tests/e2e/Google_Passwords.csv";

test("real-site Visibility collection from a local Google Passwords CSV", async (t) => {
  const csvPath = process.env["CATASHIRO_E2E_PASSWORD_CSV"] ?? DEFAULT_CSV;
  if (!existsSync(csvPath)) {
    t.skip(`set CATASHIRO_E2E_PASSWORD_CSV or place ${DEFAULT_CSV} locally`);
    return;
  }

  const stateRoot = resolve(process.env["CATASHIRO_E2E_STATE_ROOT"] ?? "state/catashiro-poc/e2e-real-visibility");
  await mkdir(stateRoot, { recursive: true });

  const vault = await VaultV2.open(join(stateRoot, "vault.json"), PASSPHRASE);
  const domain = new DomainService(vault);
  const csvBytes = new Uint8Array(await readFile(csvPath));
  const importSummary = importPasswordCsv(domain, { data: csvBytes });
  await vault.save();

  const engine = new BrowserEngine({ headless: process.env["CATASHIRO_E2E_HEADFUL"] !== "1" });
  const runner = new VisibilityRunner({
    domain,
    openSession: (site) => engine.openSession(site),
    handoff: async () => "abort",
    maxHandoffs: 1,
  });

  const results: Array<{
    siteAccountId: string;
    domain: string;
    status: string;
    disclosures: number;
    constraints: number;
    loginUrl?: string;
  }> = [];

  // Optional cap for fast local iteration; defaults to every imported site.
  const maxSites = Number.parseInt(process.env["CATASHIRO_E2E_MAX_SITES"] ?? "", 10);
  const siteAccounts = Number.isFinite(maxSites) && maxSites > 0
    ? domain.listSiteAccounts().slice(0, maxSites)
    : domain.listSiteAccounts();

  try {
    for (const site of siteAccounts) {
      const result = await runner.runSite(site.id);
      const updated = domain.getSiteAccount(site.id) ?? site;
      results.push({
        siteAccountId: site.id,
        domain: site.domain,
        status: result.status,
        disclosures: result.disclosures,
        constraints: result.constraints,
        ...(updated.url !== undefined ? { loginUrl: updated.url } : {}),
      });
    }
    await vault.save();
  } finally {
    await engine.closeAll();
  }

  const inaccessible = domain
    .listConstraints()
    .filter((constraint) => constraint.kind === "unknown-state" && constraint.detail.startsWith("access-unreachable:"))
    .map((constraint) => ({
      siteAccountId: constraint.siteAccountId,
      reason: constraint.detail.replace(/^access-unreachable:\s*/, ""),
    }));

  const wallSkipped = domain
    .listConstraints()
    .filter((constraint) => constraint.kind === "wall")
    .map((constraint) => ({
      siteAccountId: constraint.siteAccountId,
      detail: constraint.detail,
    }));

  const artifact = {
    generatedAt: new Date().toISOString(),
    importedSites: importSummary.siteAccountIds.length,
    results,
    inaccessible,
    wallSkipped,
  };
  const artifactPath = join(stateRoot, `real-visibility-${Date.now()}.json`);
  // persist: measurement-output — local-only real-site status, never credentials or raw collected values
  await writeFile(artifactPath, JSON.stringify(artifact, null, 2), "utf8");

  assert.equal(results.length, siteAccounts.length);
  assert.ok(
    results.some((result) => result.status === "collected" && result.disclosures > 0) ||
      wallSkipped.length > 0 ||
      inaccessible.length > 0,
    "expected at least one collection, wall skip, or inaccessible-site record",
  );

  await t.diagnostic(`real Visibility E2E artifact: ${artifactPath}`);
});
