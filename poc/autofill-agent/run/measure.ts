// Measurement runner (RFC-001 v3 §8): runs the registration and bulk-update
// scenarios on all 10 local test sites, per browser engine, per mapper variant,
// and measures success rate / mis-mapping rate against the ground truth that is
// embedded in the site definitions.

import { rm } from "node:fs/promises";
import { join } from "node:path";
import { chromium, firefox, webkit, type Browser, type BrowserType } from "playwright";
import { SITES, type SiteDef } from "../sites/defs.js";
import { startPocServer, type PocServer } from "../sites/server.js";
import { runRegistration, runUpdate, type AgentDeps } from "../src/agent/agent.js";
import { maskForArtifact, ScriptedGate } from "../src/agent/gate.js";
import { DeterministicMapper, type Mapper } from "../src/agent/mapper.js";
import { snapshotPage } from "../src/agent/scan.js";
import { detectWall } from "../src/agent/walls.js";
import { applyTransform, DUMMY_PROFILE_SEED, UPDATED_VALUES } from "../src/profile.js";
import { PocStore } from "../src/store/store.js";
import type { ProfileKey, Transform } from "../src/types.js";

export type EngineName = "chromium" | "firefox" | "webkit";
const ENGINES: Record<EngineName, BrowserType> = { chromium, firefox, webkit };

const PROMPTED_VALUES: Record<string, string> = { "ご職業": "会社員" };

/** Checkbox state the server must end up with ("on" present / absent). */
const EXPECTED_CHECKBOXES: Record<string, Record<string, "on" | "absent">> = {
  "05-choices": { newsletter: "absent" },
  "08-terms": { agree: "on", adult: "on" },
  "09-trial-card": { agree: "on" },
  "10-no-auto": { agree: "on" }, // checked by the human surrogate, not the agent
};

const EXPECTED_STATUS: Record<string, string> = { "10-no-auto": "assistedFill" };

export interface SiteResultRow {
  siteId: string;
  status: string;
  registrationOk: boolean;
  mappedCorrect: number;
  mappedWrong: number;
  missed: number;
  spurious: number;
  gtTotal: number;
  guardsOk: boolean;
  guardNotes: string[];
  notes: string[];
}

export interface UpdateResultRow {
  siteId: string;
  expected: "updated" | "skipped";
  actual: string;
  valuesOk: boolean;
  mandateOk: boolean;
}

export interface VariantRunResult {
  variant: string;
  engine: EngineName;
  registration: SiteResultRow[];
  update: UpdateResultRow[];
  trialCardDeclinePathOk: boolean;
  wallDetectionOk: boolean;
  wallResumeFlowOk: boolean;
  successRate: number;
  misMappingRate: number;
}

interface GtField {
  name: string;
  profileKey: ProfileKey;
  transform?: Transform;
}

function groundTruth(site: SiteDef): { mapped: GtField[]; unmappedNames: string[] } {
  const mapped: GtField[] = [];
  const unmappedNames: string[] = [];
  for (const spec of site.specs) {
    if (spec.control === "checkbox") continue;
    if (spec.gt) {
      const field: GtField = { name: spec.name, profileKey: spec.gt.profileKey };
      if (spec.gt.transform) field.transform = spec.gt.transform;
      mapped.push(field);
    } else {
      unmappedNames.push(spec.name);
    }
  }
  return { mapped, unmappedNames };
}

function expectedValue(gt: GtField, profile: ReadonlyMap<ProfileKey, string>): string {
  if (gt.profileKey.startsWith("custom.")) {
    return PROMPTED_VALUES[gt.profileKey.slice("custom.".length)] ?? "";
  }
  const master = profile.get(gt.profileKey) ?? "";
  return applyTransform(master, gt.transform, profile);
}

async function newStore(dir: string): Promise<PocStore> {
  await rm(dir, { recursive: true, force: true });
  const store = await PocStore.open(join(dir, "store.json"), process.env["AF_POC_PASSPHRASE"] ?? "poc-dummy-passphrase");
  for (const seed of DUMMY_PROFILE_SEED) store.setProfileValue(seed.key, seed.label, seed.value);
  await store.save();
  return store;
}

function profileView(store: PocStore): ReadonlyMap<ProfileKey, string> {
  // Excludes the most-sensitive field (CVV); see PocStore.profileView.
  return store.profileView();
}

function makeDeps(store: PocStore, mapper: Mapper, log: (m: string) => void): AgentDeps {
  return {
    store,
    mapper,
    gate: new ScriptedGate({ approved: true, approveAttestations: true, cardApproved: true }),
    promptUser: (label) => Promise.resolve(PROMPTED_VALUES[label] ?? "テスト値"),
    log,
  };
}

function checkGuards(site: SiteDef, row: SiteResultRow, result: Awaited<ReturnType<typeof runRegistration>>): void {
  const flags = result.highRiskFlags;
  if (site.id === "08-terms") {
    if (!flags.includes("auto-renewal")) row.guardNotes.push("高リスク条項 auto-renewal 未検出");
    if (!flags.includes("third-party-sharing")) row.guardNotes.push("高リスク条項 third-party-sharing 未検出");
  }
  if (site.id === "09-trial-card" && !flags.includes("trial-subscription")) {
    row.guardNotes.push("trial-subscription（ガード2例外）未検出");
  }
  if (site.id === "10-no-auto" && result.status !== "assistedFill") {
    row.guardNotes.push(`自動作成禁止サイトで status=${result.status}（assistedFill 期待）`);
  }
  row.guardsOk = row.guardNotes.length === 0;
}

async function runSiteRegistration(
  browser: Browser,
  server: PocServer,
  site: SiteDef,
  deps: AgentDeps,
  profile: ReadonlyMap<ProfileKey, string>,
): Promise<SiteResultRow> {
  const row: SiteResultRow = {
    siteId: site.id,
    status: "",
    registrationOk: false,
    mappedCorrect: 0,
    mappedWrong: 0,
    missed: 0,
    spurious: 0,
    gtTotal: 0,
    guardsOk: true,
    guardNotes: [],
    notes: [],
  };

  const page = await browser.newPage();
  let agentSubmitted = true;
  try {
    // Q2c surrogate: the human checks the consent box and presses the final button.
    deps.humanFinalSubmit = async (p, finalButtonSelector, consentFieldIds) => {
      agentSubmitted = false;
      for (const fieldId of consentFieldIds) await p.locator(`[data-af-id="${fieldId}"]`).check();
      if (finalButtonSelector) await p.click(finalButtonSelector);
      await p.getByText("登録が完了しました").first().waitFor({ timeout: 5000 });
    };
    const result = await runRegistration(page, server.siteUrl(site.id), deps);
    row.status = result.status;
    row.notes.push(...result.notes);

    // --- mapping accuracy vs ground truth ---
    const gt = groundTruth(site);
    row.gtTotal = gt.mapped.length;
    const plannedByName = new Map(result.planned.map((p) => [p.fieldName, p]));
    for (const g of gt.mapped) {
      const planned = plannedByName.get(g.name);
      if (!planned) row.missed++;
      else if (planned.profileKey === g.profileKey && (planned.transform ?? "") === (g.transform ?? "")) row.mappedCorrect++;
      else row.mappedWrong++;
    }
    for (const name of gt.unmappedNames) {
      if (plannedByName.has(name)) row.spurious++;
    }

    // --- submission correctness (server side) ---
    const state = server.state(site.id);
    const expectedStatus = EXPECTED_STATUS[site.id] ?? "registered";
    let ok = result.status === expectedStatus && state.registered !== undefined;
    if (state.registered) {
      for (const g of gt.mapped) {
        const expected = expectedValue(g, profile);
        if ((state.registered[g.name] ?? "") !== expected) {
          ok = false;
          row.notes.push(`値の不一致 ${g.name}: 期待="${maskNote(g, expected)}" 実際="${maskNote(g, state.registered[g.name] ?? "")}"`);
        }
      }
      for (const [name, expectation] of Object.entries(EXPECTED_CHECKBOXES[site.id] ?? {})) {
        const present = state.registered[name] === "on";
        if ((expectation === "on") !== present) {
          ok = false;
          row.notes.push(`チェックボックス ${name}: 期待=${expectation} 実際=${present ? "on" : "absent"}`);
        }
      }
    }
    if (site.id === "10-no-auto" && agentSubmitted) {
      ok = false;
      row.notes.push("エージェントが自動送信してしまった（人間委譲の検証失敗）");
    }
    row.registrationOk = ok;
    checkGuards(site, row, result);
  } catch (err) {
    row.status = "error";
    row.notes.push(String(err));
    row.registrationOk = false;
  } finally {
    delete deps.humanFinalSubmit;
    await page.close();
  }
  return row;
}

/**
 * PRIV-002 (#21): mismatch notes are written to `state/autofill-poc/matrix-*.json`,
 * so no field's raw value goes in — see `maskForArtifact`.
 */
function maskNote(gt: GtField, value: string): string {
  return maskForArtifact(gt.profileKey, value);
}

/** Guard-2 negative path: without the user's card approval, no card data may be filled or submitted. */
async function runTrialCardDeclinePath(browser: Browser, server: PocServer, mapper: Mapper, storeDir: string): Promise<boolean> {
  const store = await newStore(join(storeDir, "decline-path"));
  const deps = makeDeps(store, mapper, () => {});
  deps.gate = new ScriptedGate({ approved: true, approveAttestations: true, cardApproved: false });
  // Reset the site so the earlier (approved) registration does not mask this check.
  server.state("09-trial-card").events = [];
  delete server.state("09-trial-card").registered;
  const page = await browser.newPage();
  try {
    const result = await runRegistration(page, server.siteUrl("09-trial-card"), deps);
    const state = server.state("09-trial-card");
    return result.status === "declined" && state.registered === undefined;
  } catch {
    return false;
  } finally {
    await page.close();
    server.state("09-trial-card").events = [];
    delete server.state("09-trial-card").registered;
  }
}

/** Wall-detection skeleton check against the fixture pages (not part of the 10 patterns). */
async function runWallFixtureCheck(browser: Browser, server: PocServer): Promise<boolean> {
  const expectations: { path: string; kind: string }[] = [
    { path: "/wall-fixture/captcha", kind: "captcha" },
    { path: "/wall-fixture/otp", kind: "mfa" },
    { path: "/wall-fixture/email", kind: "email-verification" },
  ];
  const page = await browser.newPage();
  try {
    for (const { path, kind } of expectations) {
      await page.goto(server.url + path);
      const wall = detectWall(await snapshotPage(page));
      if (wall?.kind !== kind) return false;
    }
    return true;
  } finally {
    await page.close();
  }
}

/** Full orchestration check: a wall appears after final submit, then human handoff resumes to success. */
async function runWallResumeFlowCheck(browser: Browser, server: PocServer, mapper: Mapper, storeDir: string): Promise<boolean> {
  const store = await newStore(join(storeDir, "wall-resume-flow"));
  const deps = makeDeps(store, mapper, () => {});
  const page = await browser.newPage();
  let handoffs = 0;
  deps.handoff = async (wall) => {
    if (wall.kind !== "captcha") return "abort";
    handoffs += 1;
    await page.getByRole("button", { name: "人間が確認を完了" }).click();
    await page.waitForLoadState();
    return "resolved";
  };
  try {
    const result = await runRegistration(page, `${server.url}/wall-flow/`, deps);
    return result.status === "registered" && result.gateShown && handoffs === 1 && store.listSiteRecords().length === 1;
  } catch {
    return false;
  } finally {
    await page.close();
  }
}

async function runBulkUpdate(
  browser: Browser,
  server: PocServer,
  deps: AgentDeps,
  profile: ReadonlyMap<ProfileKey, string>,
): Promise<UpdateResultRow[]> {
  // §5: the user's master values change; the agent diffs hashes and fixes only stale fields.
  for (const [key, value] of Object.entries(UPDATED_VALUES)) {
    if (value === undefined) continue;
    const entry = deps.store.profile.get(key as ProfileKey);
    deps.store.setProfileValue(key as ProfileKey, entry?.label ?? key, value);
  }
  await deps.store.save();
  const newProfile = profileView(deps.store);

  const rows: UpdateResultRow[] = [];
  for (const site of SITES) {
    const gt = groundTruth(site);
    const changedFields = gt.mapped.filter((g) => {
      if (!server.state(site.id).registered) return false;
      const before = expectedValue(g, profile);
      const after = expectedValue(g, newProfile);
      return before !== after && site.specs.some((s) => s.name === g.name && s.type !== "password" && s.inEdit !== false && s.name !== "mail_confirm");
    });
    const expected = changedFields.length > 0 ? "updated" : "skipped";

    const page = await browser.newPage();
    const mandateCount = deps.store.listMandates().length;
    let actual = "error";
    try {
      const result = await runUpdate(page, server.siteUrl(site.id), site.id, deps);
      actual = result.status;
    } catch (err) {
      deps.log(`${site.id}: update error ${String(err)}`);
    } finally {
      await page.close();
    }

    let valuesOk = actual === expected;
    const state = server.state(site.id);
    if (expected === "updated" && state.registered) {
      for (const g of changedFields) {
        if ((state.registered[g.name] ?? "") !== expectedValue(g, newProfile)) valuesOk = false;
      }
    }
    if (expected === "skipped" && state.events.some((e) => e.type === "update")) valuesOk = false;
    const mandateDelta = deps.store.listMandates().length - mandateCount;
    const mandateOk = actual === "updated" ? mandateDelta === 1 : mandateDelta === 0;
    rows.push({ siteId: site.id, expected, actual, valuesOk, mandateOk });
  }
  return rows;
}

export async function runVariant(
  mapper: Mapper,
  engine: EngineName,
  stateRoot: string,
  log: (m: string) => void,
): Promise<VariantRunResult> {
  const server = await startPocServer();
  const browser = await ENGINES[engine].launch({ headless: true });
  const storeDir = join(stateRoot, `${mapper.name}-${engine}`);
  try {
    const store = await newStore(storeDir);
    const deps = makeDeps(store, mapper, log);
    const profile = profileView(store);

    const registration: SiteResultRow[] = [];
    for (const site of SITES) {
      log(`--- ${mapper.name}/${engine}: ${site.id} 新規登録 ---`);
      registration.push(await runSiteRegistration(browser, server, site, deps, profile));
    }

    log(`--- ${mapper.name}/${engine}: 差分一括更新 ---`);
    const update = await runBulkUpdate(browser, server, deps, profile);

    const trialCardDeclinePathOk = await runTrialCardDeclinePath(browser, server, mapper, storeDir);
    const wallDetectionOk = await runWallFixtureCheck(browser, server);
    const wallResumeFlowOk = await runWallResumeFlowCheck(browser, server, mapper, storeDir);

    const okCount = registration.filter((r) => r.registrationOk && r.guardsOk).length;
    const gtTotal = registration.reduce((a, r) => a + r.gtTotal, 0);
    const wrong = registration.reduce((a, r) => a + r.mappedWrong + r.spurious, 0);
    return {
      variant: mapper.name,
      engine,
      registration,
      update,
      trialCardDeclinePathOk,
      wallDetectionOk,
      wallResumeFlowOk,
      successRate: okCount / registration.length,
      misMappingRate: gtTotal === 0 ? 0 : wrong / gtTotal,
    };
  } finally {
    await browser.close();
    await server.close();
  }
}

/**
 * Visual demo: runs every test site headed, gate auto-approved, so the user can
 * watch the agent register on all 10 sites end to end without manual input.
 * slowMo makes each fill/click visible; the gate decisions are scripted to
 * approve (incl. the trial-card future charge and attestations), and the
 * auto-creation-prohibited site is completed by the human surrogate.
 */
export async function runDemo(
  mapper: Mapper,
  engine: EngineName,
  stateRoot: string,
  log: (m: string) => void,
  options?: { slowMo?: number; pauseMs?: number },
): Promise<void> {
  const server = await startPocServer();
  const browser = await ENGINES[engine].launch({ headless: false, slowMo: options?.slowMo ?? 250 });
  const pauseMs = options?.pauseMs ?? 1200;
  try {
    const store = await newStore(join(stateRoot, `demo-${mapper.name}-${engine}`));
    const deps = makeDeps(store, mapper, log);
    const profile = profileView(store);
    log(`テストサイト: ${server.url}/ （${mapper.name} / ${engine}, headed）`);
    for (const site of SITES) {
      log(`\n=== ${site.id} / ${site.serviceName} を自動登録 ===`);
      const row = await runSiteRegistration(browser, server, site, deps, profile);
      log(`  → status=${row.status}  (mapping ✓${row.mappedCorrect}/✗${row.mappedWrong}/miss${row.missed})`);
      for (const note of row.notes) log(`    note: ${note}`);
      await new Promise((resolve) => setTimeout(resolve, pauseMs));
    }
    log("\nすべてのテストサイトの自動登録デモが完了しました。");
  } finally {
    await browser.close();
    await server.close();
  }
}

export function formatResult(result: VariantRunResult): string {
  const lines: string[] = [];
  lines.push(`\n== ${result.variant} / ${result.engine} ==`);
  lines.push("site                 status        reg  map(✓/✗/miss/spur)  guards");
  for (const r of result.registration) {
    lines.push(
      `${r.siteId.padEnd(20)} ${r.status.padEnd(13)} ${r.registrationOk ? "OK " : "NG "} ${String(r.mappedCorrect).padStart(2)}/${r.mappedWrong}/${r.missed}/${r.spurious}              ${r.guardsOk ? "OK" : `NG(${r.guardNotes.join(";")})`}`,
    );
    for (const note of r.notes) lines.push(`    note: ${note}`);
  }
  lines.push("update:");
  for (const u of result.update) {
    lines.push(
      `  ${u.siteId.padEnd(20)} expected=${u.expected.padEnd(7)} actual=${u.actual.padEnd(7)} ${u.valuesOk ? "OK" : "NG"} mandate=${u.mandateOk ? "OK" : "NG"}`,
    );
  }
  lines.push(`trial-card decline path (card approval=no): ${result.trialCardDeclinePathOk ? "OK" : "NG"}`);
  lines.push(`wall detection fixtures: ${result.wallDetectionOk ? "OK" : "NG"}`);
  lines.push(`wall resume flow fixture: ${result.wallResumeFlowOk ? "OK" : "NG"}`);
  lines.push(
    `success rate: ${(result.successRate * 100).toFixed(0)}%  mis-mapping rate: ${(result.misMappingRate * 100).toFixed(1)}%`,
  );
  return lines.join("\n");
}

export function deterministicMapper(): Mapper {
  return new DeterministicMapper();
}
