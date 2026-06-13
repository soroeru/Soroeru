// Agent orchestration (RFC-001 v3 §4, §5): URL -> find registration page ->
// map fields -> review-and-confirm gate -> fill -> submit, with the three guards,
// assisted fill on auto-creation-prohibited sites, wall handoff hooks, and the
// hash-diff bulk update flow.

import type { Page } from "playwright";
import { applyTransform } from "../profile.js";
import { sha256Hex, type PocStore } from "../store/store.js";
import type {
  CheckboxClassification,
  FilledFieldRecord,
  FormField,
  GateRequest,
  MappingEntry,
  PageLink,
  PageSnapshot,
  ProfileKey,
  RegistrationStatus,
  Transform,
} from "../types.js";
import type { CustomFieldDef } from "./classifier.js";
import { findEditLink } from "./discovery.js";
import { evaluateGuards, paymentAudit, shouldCheckAttestation } from "./guards.js";
import { fillEntries, setCheckbox, type FillOutcome } from "./filler.js";
import { buildMandate, toFilledFieldRecords } from "./records.js";
import { maskValue, renderGate, type Gate } from "./gate.js";
import type { Mapper } from "./mapper.js";
import { normalizeMappingPlan, normalizeTermsAnalysis } from "./normalization.js";
import { snapshotPage, waitForFields } from "./scan.js";
import { clearWalls, type HumanHandoff } from "./walls.js";

const NEXT_BUTTON_RE = /次へ|確認画面へ|^確認する?$/;
const FINAL_BUTTON_RE = /登録|送信|作成|開始|申し?込|保存/;
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

interface StepState {
  entries: { entry: MappingEntry; field: FormField }[];
  checkboxes: { box: CheckboxClassification; field: FormField }[];
}

async function mapCurrentPage(snapshot: PageSnapshot, deps: AgentDeps): Promise<StepState> {
  const fieldsById = new Map(snapshot.fields.map((f) => [f.fieldId, f]));
  const customs = customsOf(deps.store);
  // Mapper implementations may self-normalize for direct tests/metrics, but
  // this seam is the authoritative guard before any browser side effects.
  const plan = normalizeMappingPlan(await deps.mapper.mapFields(snapshot, customs), snapshot.fields, customs);

  // Missing data (§4 step 3): ask the user, store as a reusable custom field.
  for (const fieldId of plan.unmappedRequired) {
    const field = fieldsById.get(fieldId);
    if (!field) continue;
    const label = labelOf(field);
    const value = await deps.promptUser(label);
    if (value === undefined) continue;
    const key: ProfileKey = `custom.${label}`;
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

  await page.goto(siteTopUrl);
  let snapshot = await snapshotPage(page);
  {
    const observed = await clearWallsFor(snapshot, deps, () => snapshotPage(page));
    if (observed.status === "abort") return result("manualHandoff", false);
    snapshot = observed.snapshot;
  }

  // 1. Find the registration page autonomously.
  const registerLink = await deps.mapper.discoverRegistrationLink(snapshot.links, snapshot.visibleText);
  if (!registerLink) {
    notes.push("登録ページへのリンクを発見できませんでした");
    return result("failed", false);
  }
  deps.log(`登録ページを発見: 「${registerLink.text}」 ${registerLink.href}`);
  await page.goto(registerLink.href);

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
    snapshot = await waitForFields(page);
    {
      const observed = await clearWallsFor(snapshot, deps, () => waitForFields(page));
      if (observed.status === "abort") return result("manualHandoff", false);
      snapshot = observed.snapshot;
    }
    pageTexts.push(snapshot.visibleText);
    for (const link of snapshot.links) {
      if (TERMS_LINK_RE.test(link.text)) termsLinks.set(link.href, link);
    }
    cardPresent ||= hasCardFields(snapshot.fields);

    currentStep = snapshot.fields.length > 0 ? await mapCurrentPage(snapshot, deps) : { entries: [], checkboxes: [] };
    for (const { entry, field } of currentStep.entries) {
      const plannedEntry: PlannedField = { fieldName: field.name || field.id, profileKey: entry.profileKey };
      if (entry.transform) plannedEntry.transform = entry.transform;
      planned.push(plannedEntry);
    }
    allCheckboxes.push(...currentStep.checkboxes);

    const nextButton = snapshot.buttons.find((b) => NEXT_BUTTON_RE.test(b.text));
    const finalButton = snapshot.buttons.find((b) => !NEXT_BUTTON_RE.test(b.text) && FINAL_BUTTON_RE.test(b.text));
    if (nextButton) {
      // Multi-step form: values must be typed to reach the next step. They stay
      // local in the controlled browser; the single gate still precedes the submit.
      filledOutcomes.push(
        ...(await fillEntries(
          { page, fieldsById: new Map(snapshot.fields.map((f) => [f.fieldId, f])), getValue: (k) => deps.store.getValue(k), profileView: view },
          currentStep.entries.map((e) => e.entry),
        )),
      );
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
  let termsText = "";
  for (const link of termsLinks.values()) termsText += `\n${await fetchVisibleText(link.href)}`;
  const analysis = normalizeTermsAnalysis(await deps.mapper.analyzeTerms(termsText, pageTexts.join("\n"), cardPresent));

  // 4. The single review-and-confirm gate.
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
  const decision = await deps.gate.decide(gateRequest);
  if (!decision.approved) {
    notes.push("確認ゲートで承認されなかったため中止しました");
    return result("declined", true, analysis.highRiskFlags);
  }

  // 5. Three guards (shared seam): payment stop with the trial exception, and the
  //    auto-creation ban. The same evaluateGuards path runs for both mapper variants.
  const guard = evaluateGuards({ analysis, decision, hasCardFields: cardPresent });

  const record = (status: RegistrationStatus): void => {
    const filledFields: FilledFieldRecord[] = toFilledFieldRecords(filledOutcomes, planned);
    deps.store.upsertSiteRecord({
      origin: new URL(page.url()).origin,
      siteId: siteIdFromUrl(page.url()),
      serviceName: gateRequest.serviceName,
      registeredAt: Date.now(),
      filledFields,
      status,
    });
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
    record("manualHandoff"); // audit the payment stop (no fields are filled/submitted)
    await deps.store.save();
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

  // 8. Q2c: sites that prohibit automated account creation get assisted fill only.
  if (guard.action === "assisted-fill") {
    deps.log("このサイトは自動アカウント作成を禁止しているため、最後の登録ボタンはご自身で押してください。");
    notes.push("自動作成禁止サイト: 入力のみ行い、最終送信はユーザーに委ねました");
    record("assistedFill");
    await deps.store.save();
    if (deps.humanFinalSubmit) await deps.humanFinalSubmit(page, finalButtonSelector, consentIds);
    return result("assistedFill", true, analysis.highRiskFlags);
  }

  // 9. Submit on the user's single approval (terms acceptance + final submit delegated).
  await page.click(finalButtonSelector);
  await page.waitForLoadState();
  try {
    await page.getByText(SUCCESS_TEXT).first().waitFor({ timeout: 5000 });
  } catch {
    const after = await clearWallsFor(await snapshotPage(page), deps, () => snapshotPage(page));
    if (after.status === "abort") {
      record("manualHandoff");
      await deps.store.save();
      return result("manualHandoff", true, analysis.highRiskFlags);
    }
    notes.push("送信後に完了画面を確認できませんでした");
    record("failed");
    await deps.store.save();
    return result("failed", true, analysis.highRiskFlags);
  }

  record("registered");
  await deps.store.save();
  deps.log("登録を完遂しました");
  return result("registered", true, analysis.highRiskFlags);
}

export interface UpdateResult {
  siteId: string;
  status: "updated" | "skipped" | "failed" | "manualHandoff";
  changedKeys: string[];
  planned: PlannedField[];
  notes: string[];
}

/** Bulk-update flow (§5): hash-diff against the latest master values, then fix only the stale fields. */
export async function runUpdate(page: Page, siteTopUrl: string, siteId: string, deps: AgentDeps): Promise<UpdateResult> {
  const notes: string[] = [];
  const record = deps.store.siteRecords.get(siteId);
  if (!record) return { siteId, status: "skipped", changedKeys: [], planned: [], notes: ["登録記録がありません"] };

  const view = deps.store.profileView();
  const changed = record.filledFields.filter((ff) => {
    const master = deps.store.getValue(ff.profileKey);
    if (master === undefined) return false;
    return sha256Hex(applyTransform(master, ff.transform, view)) !== ff.filledValueHash;
  });
  if (changed.length === 0) {
    return { siteId, status: "skipped", changedKeys: [], planned: [], notes: ["差分なし"] };
  }
  const changedKeySet = new Set(changed.map((c) => `${c.profileKey}|${c.transform ?? ""}`));

  await page.goto(siteTopUrl);
  let snapshot = await snapshotPage(page);
  {
    const observed = await clearWallsFor(snapshot, deps, () => snapshotPage(page));
    if (observed.status === "abort") {
      return { siteId, status: "manualHandoff", changedKeys: [...changedKeySet], planned: [], notes };
    }
    snapshot = observed.snapshot;
  }
  const editLink = findEditLink(snapshot.links);
  if (!editLink) {
    return { siteId, status: "failed", changedKeys: [...changedKeySet], planned: [], notes: ["編集ページが見つかりません"] };
  }
  await page.goto(editLink.href);
  snapshot = await waitForFields(page);
  {
    const observed = await clearWallsFor(snapshot, deps, () => waitForFields(page));
    if (observed.status === "abort") {
      return { siteId, status: "manualHandoff", changedKeys: [...changedKeySet], planned: [], notes };
    }
    snapshot = observed.snapshot;
  }

  const step = await mapCurrentPage(snapshot, deps);
  const toFill = step.entries.filter((e) => changedKeySet.has(`${e.entry.profileKey}|${e.entry.transform ?? ""}`));
  const planned: PlannedField[] = toFill.map(({ entry, field }) => ({
    fieldName: field.name || field.id,
    profileKey: entry.profileKey,
    ...(entry.transform ? { transform: entry.transform } : {}),
  }));

  const outcomes = await fillEntries(
    {
      page,
      fieldsById: new Map(snapshot.fields.map((f) => [f.fieldId, f])),
      getValue: (k) => deps.store.getValue(k),
      profileView: view,
    },
    toFill.map((e) => e.entry),
  );

  const saveButton = snapshot.buttons.find((b) => FINAL_BUTTON_RE.test(b.text));
  if (!saveButton) {
    return { siteId, status: "failed", changedKeys: [...changedKeySet], planned, notes: ["保存ボタンが見つかりません"] };
  }
  await page.click(saveButton.selector);
  await page.waitForLoadState();
  try {
    await page.getByText(UPDATE_SUCCESS_TEXT).first().waitFor({ timeout: 5000 });
  } catch {
    record.status = "failed";
    await deps.store.save();
    return { siteId, status: "failed", changedKeys: [...changedKeySet], planned, notes: ["保存完了画面を確認できませんでした"] };
  }

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
  record.status = "updated";
  record.lastUpdatedAt = Date.now();
  deps.store.upsertSiteRecord(record);
  await deps.store.save();
  deps.log(`${siteId}: 差分 ${changed.length} 項目を更新しました`);
  return { siteId, status: "updated", changedKeys: [...changedKeySet], planned, notes };
}
