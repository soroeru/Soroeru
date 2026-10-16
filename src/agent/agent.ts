// Agent orchestration (RFC-001 v3 §4, §5): URL -> find registration page ->
// map fields -> review-and-confirm gate -> fill -> submit, with the three guards,
// assisted fill on auto-creation-prohibited sites, wall handoff hooks, and the
// hash-diff bulk update flow.

import { ConsequenceApprovals, consequenceDigest } from "../domain/consequence-approval.js";
import type { GateDecision } from "../types.js";
import type { Page } from "playwright";
import { applyTransform } from "../profile.js";
import { sha256Hex, type PocStore } from "../store/store.js";
import type {
  CheckboxClassification,
  FilledFieldRecord,
  FormField,
  GateRequest,
  HighRiskFlag,
  LocalCandidateDefinition,
  MappingEntry,
  PageLink,
  PageSnapshot,
  ProfileKey,
  RegistrationStatus,
  Transform,
} from "../types.js";
import type { CustomFieldDef } from "./classifier.js";
import { resolveDefinitions } from "./definitions.js";
import { findEditLink } from "./discovery.js";
import { evaluateGuards, paymentAudit, shouldCheckAttestation } from "./guards.js";
import { fillEntries, setCheckbox, type FillOutcome } from "./filler.js";
import { OFFICIAL_DEFINITIONS } from "./official-definitions.js";
import { accountStateFromRegistrationStatus, applyAccountState, buildMandate, staleFilledFields, toFilledFieldRecords } from "./records.js";
import { maskValue, renderGate, type Gate } from "./gate.js";
import type { Mapper } from "./mapper.js";
import { normalizeMappingPlan, normalizeTermsAnalysis } from "./normalization.js";
import { slowPhaseNote, type Phase } from "./perf.js";
import { snapshotPage, waitForFields } from "./scan.js";
import { clearWalls, type HumanHandoff } from "./walls.js";

const NEXT_BUTTON_RE = /次へ|確認画面へ|^確認する?$/;
const FINAL_BUTTON_RE = /登録|送信|作成|開始|申し?込|保存/;
const WITHDRAWAL_FINAL_RE = /退会|解約|削除|アカウント削除|停止|withdraw|delete|cancel/i;
const TERMS_LINK_RE = /規約|ポリシー/;
const CARD_FIELD_RE = /カード|クレジット|cvv|cvc|セキュリティコード/i;
const SUCCESS_TEXT = "登録が完了しました";
const UPDATE_SUCCESS_TEXT = "変更を保存しました";

export interface AgentDeps {
  store: PocStore;
  gate: Gate;
  mapper: Mapper;
  /** Missing-data prompt (§4 step 3). Returns the value, or undefined to skip. */
  promptUser: (fieldLabel: string) => Promise<string | undefined>;
  /** Wall handoff (§10b). Without it, a detected wall ends the run as manualHandoff. */
  handoff?: HumanHandoff;
  /**
   * Q2c surrogate: called instead of auto-submitting on auto-creation-prohibited
   * sites ("please press the final button yourself"). The runner uses this to
   * simulate the human completing the registration.
   */
  humanFinalSubmit?: (page: Page, finalButtonSelector: string | undefined, consentFieldIds: string[]) => Promise<void>;
  /**
   * Phase-timing hook (PERF-001 / #18): called once per phase with that
   * phase's cumulative duration (ms) for this run. Multi-step forms add to
   * the same phase across steps. Carries no profile values, page content, AI
   * request payloads, or provider API keys — only a phase name and a number.
   */
  onPhase?: (phase: Phase, durationMs: number) => void;
  log: (message: string) => void;
}

export interface PlannedField {
  fieldName: string;
  profileKey: ProfileKey;
  transform?: Transform;
}

export interface RegistrationResult {
  status: RegistrationStatus;
  planned: PlannedField[];
  gateShown: boolean;
  highRiskFlags: string[];
  notes: string[];
}

function labelOf(field: FormField): string {
  const raw = field.labels[0] ?? field.placeholder ?? field.nearbyText ?? field.name;
  return raw.replace(/（必須）/g, "").trim() || field.name;
}

function customsOf(store: PocStore): CustomFieldDef[] {
  return [...store.profile.values()]
    .filter((e) => e.key.startsWith("custom."))
    .map((e) => ({ key: e.key, matchTerms: e.matchTerms ?? [e.label] }));
}

function candidateCustomsOf(candidates: LocalCandidateDefinition[]): CustomFieldDef[] {
  return candidates
    .filter((candidate) => candidate.status !== "rejected")
    .flatMap((candidate) =>
      (candidate.fieldRules ?? [])
        .filter((rule) => rule.profileKey.startsWith("custom."))
        .map((rule) => ({ key: rule.profileKey, matchTerms: [rule.labelPattern ?? rule.attrPattern ?? rule.id] })),
    );
}

function mergeCustoms(...groups: CustomFieldDef[][]): CustomFieldDef[] {
  const byKey = new Map<string, CustomFieldDef>();
  for (const custom of groups.flat()) {
    const existing = byKey.get(custom.key);
    byKey.set(custom.key, existing ? { key: custom.key, matchTerms: [...new Set([...existing.matchTerms, ...custom.matchTerms])] } : custom);
  }
  return [...byKey.values()];
}

function hasCardFields(fields: FormField[]): boolean {
  return fields.some(
    (f) =>
      f.autocomplete.startsWith("cc-") ||
      CARD_FIELD_RE.test([...f.labels, f.placeholder, f.nearbyText, f.name, f.id].join(" ")),
  );
}

function siteIdFromUrl(url: string): string {
  return /\/site\/([^/]+)/.exec(url)?.[1] ?? new URL(url).host;
}

async function fetchVisibleText(url: string): Promise<string> {
  try {
    // egress: target-site — terms links discovered on the site the user is registering on
    const res = await fetch(url);
    const html = await res.text();
    return html.replace(/<script[\s\S]*?<\/script>/gi, " ").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
  } catch {
    return "";
  }
}

/**
 * Pause/resume gate around any detected wall. On "clear" the returned snapshot
 * is the resumed page (re-observed via `reobserve` after each resolved handoff),
 * so the caller's mapper / three guards / gate / fill always run against the
 * current page, never the pre-handoff one. On "abort" the caller records
 * manualHandoff. The wall is detected and handed off — never solved or bypassed.
 */
function clearWallsFor(
  snapshot: PageSnapshot,
  deps: AgentDeps,
  reobserve: () => Promise<PageSnapshot>,
): Promise<{ snapshot: PageSnapshot; status: "clear" | "abort" }> {
  return clearWalls(snapshot, {
    ...(deps.handoff ? { handoff: deps.handoff } : {}),
    reobserve,
    log: deps.log,
  });
}

/** Report a phase's elapsed time (PERF-001 / #18) and, if it ran long, log a slow-path note. */
function recordPhase(deps: AgentDeps, phase: Phase, startedAt: number): void {
  const durationMs = performance.now() - startedAt;
  deps.onPhase?.(phase, durationMs);
  const note = slowPhaseNote(phase, durationMs);
  if (note) deps.log(note);
}

interface StepState {
  entries: { entry: MappingEntry; field: FormField }[];
  checkboxes: { box: CheckboxClassification; field: FormField }[];
}

async function mapCurrentPage(snapshot: PageSnapshot, deps: AgentDeps): Promise<StepState> {
  const fieldsById = new Map(snapshot.fields.map((f) => [f.fieldId, f]));
  const localCandidates = deps.store.listLocalCandidates();
  const customs = mergeCustoms(customsOf(deps.store), candidateCustomsOf(localCandidates));
  // Mapper implementations may self-normalize for direct tests/metrics, but
  // this seam is the authoritative guard before any browser side effects.
  const plan = normalizeMappingPlan(
    await deps.mapper.mapFields(snapshot, customs, { localCandidates }),
    snapshot.fields,
    customs,
  );
  const missingCustomKeyByFieldId = new Map<string, ProfileKey>();
  plan.entries = plan.entries.filter((entry) => {
    const field = fieldsById.get(entry.fieldId);
    if (!entry.profileKey.startsWith("custom.") || deps.store.getValue(entry.profileKey) !== undefined || !field?.required) return true;
    missingCustomKeyByFieldId.set(entry.fieldId, entry.profileKey);
    return false;
  });
  plan.unmappedRequired = [...new Set([...plan.unmappedRequired, ...missingCustomKeyByFieldId.keys()])];

  // Missing data (§4 step 3): ask the user, store as a reusable custom field.
  for (const fieldId of plan.unmappedRequired) {
    const field = fieldsById.get(fieldId);
    if (!field) continue;
    const label = labelOf(field);
    const value = await deps.promptUser(label);
    if (value === undefined) continue;
    const key: ProfileKey = missingCustomKeyByFieldId.get(fieldId) ?? `custom.${label}`;
    deps.store.setProfileValue(key, label, value, [label]);
    plan.entries.push({ fieldId, profileKey: key });
    deps.log(`未保存の項目「${label}」を入力してもらい、新項目 ${key} として保存しました`);
  }

  const entries = plan.entries
    .map((entry) => ({ entry, field: fieldsById.get(entry.fieldId) }))
    .filter((x): x is { entry: MappingEntry; field: FormField } => x.field !== undefined);
  const checkboxes = plan.checkboxes
    .map((box) => ({ box, field: fieldsById.get(box.fieldId) }))
    .filter((x): x is { box: CheckboxClassification; field: FormField } => x.field !== undefined);
  return { entries, checkboxes };
}

export async function runRegistration(page: Page, siteTopUrl: string, deps: AgentDeps): Promise<RegistrationResult> {
  const notes: string[] = [];
  const planned: PlannedField[] = [];
  const result = (status: RegistrationStatus, gateShown: boolean, flags: string[] = []): RegistrationResult => ({
    status,
    planned,
    gateShown,
    highRiskFlags: flags,
    notes,
  });

  const discoverStart = performance.now();
  await page.goto(siteTopUrl);
  let snapshot = await snapshotPage(page);
  {
    const observed = await clearWallsFor(snapshot, deps, () => snapshotPage(page));
    if (observed.status === "abort") {
      recordPhase(deps, "discover", discoverStart);
      return result("manualHandoff", false);
    }
    snapshot = observed.snapshot;
  }

  // 1. Find the registration page autonomously.
  const registerLink = await deps.mapper.discoverRegistrationLink(snapshot.links, snapshot.visibleText);
  if (!registerLink) {
    notes.push("登録ページへのリンクを発見できませんでした");
    recordPhase(deps, "discover", discoverStart);
    return result("failed", false);
  }
  deps.log(`登録ページを発見: 「${registerLink.text}」 ${registerLink.href}`);
  await page.goto(registerLink.href);
  recordPhase(deps, "discover", discoverStart);

  // 2. Analyze (and, for wizards, advance through) the form.
  const allCheckboxes: { box: CheckboxClassification; field: FormField }[] = [];
  const termsLinks = new Map<string, PageLink>();
  const pageTexts: string[] = [];
  let cardPresent = false;
  let currentStep: StepState = { entries: [], checkboxes: [] };
  let finalButtonSelector: string | undefined;
  const filledOutcomes: FillOutcome[] = [];
  const view = deps.store.profileView();

  for (let step = 0; step < 6; step++) {
    const scanStart = performance.now();
    snapshot = await waitForFields(page);
    {
      const observed = await clearWallsFor(snapshot, deps, () => waitForFields(page));
      if (observed.status === "abort") {
        recordPhase(deps, "scan", scanStart);
        return result("manualHandoff", false);
      }
      snapshot = observed.snapshot;
    }
    pageTexts.push(snapshot.visibleText);
    for (const link of snapshot.links) {
      if (TERMS_LINK_RE.test(link.text)) termsLinks.set(link.href, link);
    }
    cardPresent ||= hasCardFields(snapshot.fields);
    recordPhase(deps, "scan", scanStart);

    const mapStart = performance.now();
    currentStep = snapshot.fields.length > 0 ? await mapCurrentPage(snapshot, deps) : { entries: [], checkboxes: [] };
    for (const { entry, field } of currentStep.entries) {
      const plannedEntry: PlannedField = { fieldName: field.name || field.id, profileKey: entry.profileKey };
      if (entry.transform) plannedEntry.transform = entry.transform;
      planned.push(plannedEntry);
    }
    allCheckboxes.push(...currentStep.checkboxes);
    recordPhase(deps, "map", mapStart);

    const nextButton = snapshot.buttons.find((b) => NEXT_BUTTON_RE.test(b.text));
    const finalButton = snapshot.buttons.find((b) => !NEXT_BUTTON_RE.test(b.text) && FINAL_BUTTON_RE.test(b.text));
    if (nextButton) {
      // Multi-step form: values must be typed to reach the next step. They stay
      // local in the controlled browser; the single gate still precedes the submit.
      const wizardFillStart = performance.now();
      filledOutcomes.push(
        ...(await fillEntries(
          { page, fieldsById: new Map(snapshot.fields.map((f) => [f.fieldId, f])), getValue: (k) => deps.store.getValue(k), profileView: view },
          currentStep.entries.map((e) => e.entry),
        )),
      );
      recordPhase(deps, "fill", wizardFillStart);
      currentStep = { entries: [], checkboxes: [] };
      await page.click(nextButton.selector);
      await page.waitForLoadState();
      continue;
    }
    finalButtonSelector = finalButton?.selector;
    break;
  }

  if (!finalButtonSelector) {
    notes.push("送信ボタンを特定できませんでした");
    return result("failed", false);
  }

  // 3. Terms analysis (guards 1-2, Q2c). Linked terms pages are fetched locally.
  const termsStart = performance.now();
  let termsText = "";
  for (const link of termsLinks.values()) termsText += `\n${await fetchVisibleText(link.href)}`;
  const analysis = normalizeTermsAnalysis(await deps.mapper.analyzeTerms(termsText, pageTexts.join("\n"), cardPresent));
  recordPhase(deps, "terms", termsStart);

  // 4. The single review-and-confirm gate.
  const gateStart = performance.now();
  const attestations = allCheckboxes.filter((c) => c.box.role === "attestation");
  const gateRequest: GateRequest = {
    origin: new URL(page.url()).origin,
    serviceName: (await page.title()).split(" - ")[0] ?? page.url(),
    fields: planned.map((p) => {
      const master = deps.store.getValue(p.profileKey) ?? "";
      const value = applyTransform(master, p.transform, view);
      const labelEntry = [...currentStep.entries].find((e) => (e.field.name || e.field.id) === p.fieldName);
      return {
        label: labelEntry ? labelOf(labelEntry.field) : p.fieldName,
        profileKey: p.profileKey,
        maskedValue: maskValue(p.profileKey, value),
      };
    }),
    termsLinks: [...termsLinks.values()],
    analysis,
    attestations: attestations.map((a) => ({ fieldId: a.box.fieldId, label: a.box.label })),
  };
  deps.log(renderGate(gateRequest));
  recordPhase(deps, "gate", gateStart);
  const decision = await decideConsequence(deps, "registration", gateRequest, { termsText, pageTexts, planned });
  if (!decision.approved) {
    notes.push("確認ゲートで承認されなかったため中止しました");
    return result("declined", true, analysis.highRiskFlags);
  }

  // 5. Three guards (shared seam): payment stop with the trial exception, and the
  //    auto-creation ban. The same evaluateGuards path runs for both mapper variants.
  const guard = evaluateGuards({ analysis, decision, hasCardFields: cardPresent });

  const record = (status: RegistrationStatus): void => {
    const filledFields: FilledFieldRecord[] = toFilledFieldRecords(filledOutcomes, planned);
    const now = Date.now();
    deps.store.upsertSiteRecord(applyAccountState({
      origin: new URL(page.url()).origin,
      siteId: siteIdFromUrl(page.url()),
      serviceName: gateRequest.serviceName,
      registeredAt: now,
      filledFields,
      accountState: "unknown",
      status,
    }, accountStateFromRegistrationStatus(status), now));
    deps.store.addMandate(
      buildMandate({
        origin: gateRequest.origin,
        submittedFieldKeys: planned.map((p) => p.profileKey),
        ...(([...termsLinks.values()][0]?.href) ? { termsUrl: [...termsLinks.values()][0]!.href } : {}),
        ...(termsText ? { termsText } : {}),
        highRiskFlags: analysis.highRiskFlags,
        attestationsApproved: attestations
          .filter((a) => decision.attestationApprovals[a.box.fieldId])
          .map((a) => a.box.label),
        result: status,
        audit: paymentAudit(analysis, cardPresent, guard),
      }),
    );
  };

  let entriesToFill = currentStep.entries.map((e) => e.entry);
  if (guard.action === "stop-handoff") {
    notes.push(`支払い項目を検知（判定: ${analysis.payment ?? "unknown"}）。自動進行を停止しハンドオフします`);
    const recordStart = performance.now();
    record("manualHandoff"); // audit the payment stop (no fields are filled/submitted)
    await deps.store.save();
    recordPhase(deps, "record", recordStart);
    return result("manualHandoff", true, analysis.highRiskFlags);
  }
  if (guard.action === "declined") {
    notes.push("将来課金が承認されなかったため、カード入力を行わず中止しました");
    return result("declined", true, analysis.highRiskFlags);
  }
  if (guard.fillCard) {
    deps.log("無料トライアル→サブスク課金をユーザーが承認。保存カードを自動入力します（ガード2の例外）");
  } else {
    entriesToFill = entriesToFill.filter((e) => !e.profileKey.startsWith("card."));
  }

  // 6. Fill remaining fields (single-step sites fill here, after the gate).
  const fillStart = performance.now();
  filledOutcomes.push(
    ...(await fillEntries(
      {
        page,
        fieldsById: new Map(snapshot.fields.map((f) => [f.fieldId, f])),
        getValue: (k) => deps.store.getValue(k),
        profileView: view,
      },
      entriesToFill,
    )),
  );

  // 7. Checkboxes: ordinary consent is accepted on the user's approval; attestations
  //    only per the user's explicit per-item decision (guard 3); opt-ins stay untouched.
  const consentIds: string[] = [];
  for (const { box } of allCheckboxes) {
    if (box.role === "terms-consent") {
      if (analysis.prohibitsAutoCreation) {
        consentIds.push(box.fieldId); // left to the human along with the final button
      } else {
        await setCheckbox(page, box.fieldId, true);
        deps.log(`通常の規約同意「${box.label}」を承認済みゲートに基づきチェックしました`);
      }
    } else if (box.role === "attestation") {
      if (shouldCheckAttestation(decision, box.fieldId)) {
        await setCheckbox(page, box.fieldId, true);
        deps.log(`ユーザーの明示判断により「${box.label}」をチェックしました`);
      } else {
        deps.log(`「${box.label}」はユーザー判断がないためチェックしません（ガード3）`);
      }
    }
  }
  recordPhase(deps, "fill", fillStart);

  // 8. Q2c: sites that prohibit automated account creation get assisted fill only.
  if (guard.action === "assisted-fill") {
    deps.log("このサイトは自動アカウント作成を禁止しているため、最後の登録ボタンはご自身で押してください。");
    notes.push("自動作成禁止サイト: 入力のみ行い、最終送信はユーザーに委ねました");
    const recordStart = performance.now();
    record("assistedFill");
    await deps.store.save();
    recordPhase(deps, "record", recordStart);
    if (deps.humanFinalSubmit) await deps.humanFinalSubmit(page, finalButtonSelector, consentIds);
    return result("assistedFill", true, analysis.highRiskFlags);
  }

  // 9. Submit on the user's single approval (terms acceptance + final submit delegated).
  const submitStart = performance.now();
  await page.click(finalButtonSelector);
  await page.waitForLoadState();
  try {
    await page.getByText(SUCCESS_TEXT).first().waitFor({ timeout: 5000 });
  } catch {
    const after = await clearWallsFor(await snapshotPage(page), deps, () => snapshotPage(page));
    if (after.status === "abort") {
      recordPhase(deps, "submit", submitStart);
      const recordStart = performance.now();
      record("manualHandoff");
      await deps.store.save();
      recordPhase(deps, "record", recordStart);
      return result("manualHandoff", true, analysis.highRiskFlags);
    }
    try {
      await page.getByText(SUCCESS_TEXT).first().waitFor({ timeout: 1000 });
    } catch {
      if (!after.snapshot.visibleText.includes(SUCCESS_TEXT)) {
        notes.push("送信後に完了画面を確認できませんでした");
        recordPhase(deps, "submit", submitStart);
        const recordStart = performance.now();
        record("failed");
        await deps.store.save();
        recordPhase(deps, "record", recordStart);
        return result("failed", true, analysis.highRiskFlags);
      }
    }
  }
  recordPhase(deps, "submit", submitStart);

  const recordStart = performance.now();
  record("registered");
  await deps.store.save();
  recordPhase(deps, "record", recordStart);
  deps.log("登録を完遂しました");
  return result("registered", true, analysis.highRiskFlags);
}

export interface UpdateResult {
  siteId: string;
  status: "updated" | "skipped" | "declined" | "failed" | "manualHandoff";
  changedKeys: string[];
  planned: PlannedField[];
  notes: string[];
}

export interface UpdateOptions {
  /** Optional profile keys selected by the UI. Omitted means all stale fields. */
  profileKeys?: readonly ProfileKey[];
}

export interface WithdrawalResult {
  siteId: string;
  status: "prepared" | "skipped" | "failed" | "manualHandoff";
  steps: string[];
  finalActionManual: true;
  notes: string[];
}

function safeStepRegex(pattern: string): RegExp | undefined {
  try {
    return new RegExp(pattern, "i");
  } catch {
    return undefined;
  }
}

/**
 * Withdrawal preparation flow (§8): follow checked-in/local withdrawal steps,
 * pause at walls, and stop before any irreversible final action. This prepares
 * the headed browser for the user; it never clicks the final withdrawal/delete
 * confirmation button.
 */
export async function runWithdrawal(page: Page, siteTopUrl: string, siteId: string, deps: AgentDeps): Promise<WithdrawalResult> {
  const notes: string[] = [];
  const steps: string[] = [];
  const result = (status: WithdrawalResult["status"]): WithdrawalResult => ({
    siteId,
    status,
    steps,
    finalActionManual: true,
    notes,
  });

  const record = deps.store.siteRecords.get(siteId);
  if (!record) return { ...result("skipped"), notes: ["登録記録がありません"] };
  if (record.accountState !== "withdrawalCandidate") {
    return { ...result("skipped"), notes: ["退会候補ではありません"] };
  }

  const discoverStart = performance.now();
  await page.goto(siteTopUrl);
  let snapshot = await snapshotPage(page);
  {
    const observed = await clearWallsFor(snapshot, deps, () => snapshotPage(page));
    if (observed.status === "abort") {
      recordPhase(deps, "discover", discoverStart);
      return result("manualHandoff");
    }
    snapshot = observed.snapshot;
  }

  const definitions = resolveDefinitions(snapshot, OFFICIAL_DEFINITIONS, deps.store.listLocalCandidates());
  const definition = definitions.find((match) => (match.definition.withdrawalSteps?.length ?? 0) > 0)?.definition;
  const withdrawalSteps = definition?.withdrawalSteps ?? [];
  if (withdrawalSteps.length === 0) {
    notes.push("退会フロー定義が見つかりません");
    recordPhase(deps, "discover", discoverStart);
    return result("failed");
  }
  deps.log(`退会フロー定義を使用: ${definition?.serviceName ?? siteId}`);

  for (const step of withdrawalSteps) {
    steps.push(step.description);
    deps.log(`退会準備: ${step.description}`);
    if (!step.linkPattern) continue;
    const re = safeStepRegex(step.linkPattern);
    if (!re) {
      notes.push(`退会ステップのリンクパターンが不正です: ${step.linkPattern}`);
      recordPhase(deps, "discover", discoverStart);
      return result("failed");
    }
    const link = snapshot.links.find((candidate) => re.test(candidate.text));
    if (!link) {
      notes.push(`退会ステップのリンクが見つかりません: ${step.description}`);
      recordPhase(deps, "discover", discoverStart);
      return result("failed");
    }
    await page.goto(link.href);
    snapshot = await snapshotPage(page);
    const observed = await clearWallsFor(snapshot, deps, () => snapshotPage(page));
    if (observed.status === "abort") {
      recordPhase(deps, "discover", discoverStart);
      return result("manualHandoff");
    }
    snapshot = observed.snapshot;
  }
  recordPhase(deps, "discover", discoverStart);

  const scanStart = performance.now();
  snapshot = await snapshotPage(page);
  const finalButton = snapshot.buttons.find((button) => WITHDRAWAL_FINAL_RE.test(button.text));
  if (finalButton) {
    notes.push(`最終操作候補「${finalButton.text}」を検出しました。自動クリックせず、ユーザー確認に委ねます`);
  } else {
    notes.push("退会ページを準備しました。不可逆な最終操作はユーザー確認に委ねます");
  }
  recordPhase(deps, "scan", scanStart);

  const recordStart = performance.now();
  const now = Date.now();
  record.withdrawalPreparedAt = now;
  record.withdrawalFinalConfirmationRequired = true;
  record.lastCheckedAt = now;
  record.nextAction = "prepareWithdrawal";
  deps.store.upsertSiteRecord(record);
  await deps.store.save();
  recordPhase(deps, "record", recordStart);
  return result("prepared");
}

/** Bulk-update flow (§5): hash-diff against the latest master values, then fix only the stale fields. */
export async function runUpdate(page: Page, siteTopUrl: string, siteId: string, deps: AgentDeps, options: UpdateOptions = {}): Promise<UpdateResult> {
  const notes: string[] = [];
  const record = deps.store.siteRecords.get(siteId);
  if (!record) return { siteId, status: "skipped", changedKeys: [], planned: [], notes: ["登録記録がありません"] };

  const view = deps.store.profileView();
  const selectedKeys = options.profileKeys ? new Set(options.profileKeys) : undefined;
  const changed = staleFilledFields(deps.store, record).filter((field) => !selectedKeys || selectedKeys.has(field.profileKey));
  if (changed.length > 0 && (record.accountState === "registered" || record.accountState === "imported")) {
    deps.store.setSiteAccountState(siteId, "updateNeeded");
  }
  if (changed.length === 0) {
    deps.store.setSiteAccountState(siteId, record.accountState === "imported" ? "imported" : "registered");
    return { siteId, status: "skipped", changedKeys: [], planned: [], notes: ["差分なし"] };
  }
  const changedKeySet = new Set(changed.map((c) => `${c.profileKey}|${c.transform ?? ""}`));

  const discoverStart = performance.now();
  await page.goto(siteTopUrl);
  let snapshot = await snapshotPage(page);
  {
    const observed = await clearWallsFor(snapshot, deps, () => snapshotPage(page));
    if (observed.status === "abort") {
      recordPhase(deps, "discover", discoverStart);
      return { siteId, status: "manualHandoff", changedKeys: [...changedKeySet], planned: [], notes };
    }
    snapshot = observed.snapshot;
  }
  const editLink = findEditLink(snapshot.links);
  if (!editLink) {
    recordPhase(deps, "discover", discoverStart);
    return { siteId, status: "failed", changedKeys: [...changedKeySet], planned: [], notes: ["編集ページが見つかりません"] };
  }
  await page.goto(editLink.href);
  recordPhase(deps, "discover", discoverStart);

  const scanStart = performance.now();
  snapshot = await waitForFields(page);
  {
    const observed = await clearWallsFor(snapshot, deps, () => waitForFields(page));
    if (observed.status === "abort") {
      recordPhase(deps, "scan", scanStart);
      return { siteId, status: "manualHandoff", changedKeys: [...changedKeySet], planned: [], notes };
    }
    snapshot = observed.snapshot;
  }
  recordPhase(deps, "scan", scanStart);

  const mapStart = performance.now();
  const step = await mapCurrentPage(snapshot, deps);
  const toFill = step.entries.filter((e) => changedKeySet.has(`${e.entry.profileKey}|${e.entry.transform ?? ""}`));
  const planned: PlannedField[] = toFill.map(({ entry, field }) => ({
    fieldName: field.name || field.id,
    profileKey: entry.profileKey,
    ...(entry.transform ? { transform: entry.transform } : {}),
  }));
  recordPhase(deps, "map", mapStart);

  const saveButton = snapshot.buttons.find((b) => FINAL_BUTTON_RE.test(b.text));
  if (!saveButton) {
    return { siteId, status: "failed", changedKeys: [...changedKeySet], planned, notes: ["保存ボタンが見つかりません"] };
  }

  const termsStart = performance.now();
  const termsLinks = new Map<string, PageLink>();
  for (const link of snapshot.links) {
    if (TERMS_LINK_RE.test(link.text)) termsLinks.set(link.href, link);
  }
  let termsText = "";
  for (const link of termsLinks.values()) termsText += `\n${await fetchVisibleText(link.href)}`;
  const rawAnalysis = normalizeTermsAnalysis(await deps.mapper.analyzeTerms(termsText, snapshot.visibleText, hasCardFields(snapshot.fields)));
  recordPhase(deps, "terms", termsStart);

  const gateStart = performance.now();
  const analysis = {
    ...rawAnalysis,
    highRiskFlags: rawAnalysis.highRiskFlags.filter((flag): flag is HighRiskFlag => flag !== "no-auto-creation"),
    prohibitsAutoCreation: false,
  };
  const attestations = step.checkboxes.filter((c) => c.box.role === "attestation");
  const gateRequest: GateRequest = {
    origin: new URL(page.url()).origin,
    serviceName: record.serviceName,
    fields: toFill.map(({ entry, field }) => {
      const master = deps.store.getValue(entry.profileKey) ?? "";
      return {
        label: labelOf(field),
        profileKey: entry.profileKey,
        maskedValue: maskValue(entry.profileKey, applyTransform(master, entry.transform, view)),
      };
    }),
    termsLinks: [...termsLinks.values()],
    analysis,
    attestations: attestations.map((a) => ({ fieldId: a.box.fieldId, label: a.box.label })),
  };
  deps.log(renderGate(gateRequest));
  recordPhase(deps, "gate", gateStart);
  const decision = await decideConsequence(deps, "update", gateRequest, { termsText, pageText: snapshot.visibleText, planned });
  const guard = evaluateGuards({ analysis, decision, hasCardFields: hasCardFields(snapshot.fields) });
  const addUpdateMandate = (result: "updated" | RegistrationStatus): void => {
    deps.store.addMandate(
      buildMandate({
        origin: gateRequest.origin,
        submittedFieldKeys: planned.map((p) => p.profileKey),
        ...(([...termsLinks.values()][0]?.href) ? { termsUrl: [...termsLinks.values()][0]!.href } : {}),
        ...(termsText ? { termsText } : {}),
        highRiskFlags: analysis.highRiskFlags,
        attestationsApproved: attestations
          .filter((a) => decision.attestationApprovals[a.box.fieldId])
          .map((a) => a.box.label),
        result,
        audit: paymentAudit(analysis, hasCardFields(snapshot.fields), guard),
      }),
    );
  };
  if (guard.action === "declined") {
    notes.push("更新前の確認ゲートで承認されなかったため中止しました");
    return { siteId, status: "declined", changedKeys: [...changedKeySet], planned, notes };
  }
  if (guard.action === "stop-handoff") {
    notes.push(`更新フォームで支払い項目を検知（判定: ${analysis.payment ?? "unknown"}）。自動進行を停止しハンドオフします`);
    const recordStart = performance.now();
    addUpdateMandate("manualHandoff");
    await deps.store.save();
    recordPhase(deps, "record", recordStart);
    return { siteId, status: "manualHandoff", changedKeys: [...changedKeySet], planned, notes };
  }

  const fillStart = performance.now();
  const outcomes = await fillEntries(
    {
      page,
      fieldsById: new Map(snapshot.fields.map((f) => [f.fieldId, f])),
      getValue: (k) => deps.store.getValue(k),
      profileView: view,
    },
    toFill.map((e) => e.entry),
  );

  for (const { box } of step.checkboxes) {
    if (box.role === "terms-consent") {
      await setCheckbox(page, box.fieldId, true);
      deps.log(`更新前ゲートに基づき通常の規約同意「${box.label}」をチェックしました`);
    } else if (box.role === "attestation") {
      if (shouldCheckAttestation(decision, box.fieldId)) {
        await setCheckbox(page, box.fieldId, true);
        deps.log(`ユーザーの明示判断により更新時の「${box.label}」をチェックしました`);
      } else {
        deps.log(`更新時の「${box.label}」はユーザー判断がないためチェックしません（ガード3）`);
      }
    }
  }
  recordPhase(deps, "fill", fillStart);

  const submitStart = performance.now();
  await page.click(saveButton.selector);
  await page.waitForLoadState();
  try {
    await page.getByText(UPDATE_SUCCESS_TEXT).first().waitFor({ timeout: 5000 });
  } catch {
    recordPhase(deps, "submit", submitStart);
    const recordStart = performance.now();
    record.status = "failed";
    applyAccountState(record, "updateFailed");
    await deps.store.save();
    recordPhase(deps, "record", recordStart);
    return { siteId, status: "failed", changedKeys: [...changedKeySet], planned, notes: ["保存完了画面を確認できませんでした"] };
  }
  recordPhase(deps, "submit", submitStart);

  const recordStart = performance.now();
  for (const outcome of outcomes.filter((o) => o.ok)) {
    for (const ff of record.filledFields) {
      if (ff.profileKey === outcome.profileKey && (ff.fieldName === outcome.fieldName || ff.transform === undefined)) {
        ff.filledValueHash = sha256Hex(outcome.filledValue);
        ff.filledAt = Date.now();
      }
    }
  }
  // Recompute hashes for entries matched by key+transform (covers renamed fields between pages).
  for (const ff of record.filledFields) {
    const master = deps.store.getValue(ff.profileKey);
    if (master !== undefined && changedKeySet.has(`${ff.profileKey}|${ff.transform ?? ""}`)) {
      ff.filledValueHash = sha256Hex(applyTransform(master, ff.transform, view));
    }
  }
  const now = Date.now();
  record.status = "updated";
  record.lastUpdatedAt = now;
  applyAccountState(record, "registered", now);
  deps.store.upsertSiteRecord(record);
  addUpdateMandate("updated");
  await deps.store.save();
  recordPhase(deps, "record", recordStart);
  deps.log(`${siteId}: 差分 ${changed.length} 項目を更新しました`);
  return { siteId, status: "updated", changedKeys: [...changedKeySet], planned, notes };
}

async function decideConsequence(deps: AgentDeps, operation: "registration" | "update", request: GateRequest, concrete: unknown): Promise<GateDecision> {
  const actionId = globalThis.crypto.randomUUID();
  const approvals = new ConsequenceApprovals<GateDecision>(actionId, async event => {
    // Legacy encrypted storage: only identifiers, digest and outcome; no request/body copy.
    deps.store.addDiagnosticEvent({ type: "flow", severity: "info", message: "consequence-approval", metadata: {
      actionId: event.actionId, operation: event.operation, targetHash: await consequenceDigest(event.targetIds),
      scopeRevision: event.scopeRevision, policyVersion: event.policyVersion, consequenceDigest: event.consequenceDigest, outcome: event.outcome,
    } });
    await deps.store.save();
  });
  return approvals.decide({ actionId, operation, targetIds: [request.origin], scopeRevision: 0, policyVersion: 1,
    consequenceDigest: await consequenceDigest({ request, concrete }) }, () => deps.gate.decide(request), request.attestations.length > 0);
}
