// Shared site-collection chrome used by the Disclosure ledger after Issue #341
// folded the Site Management tab into the ledger. Batch progress, wall hand-off,
// collection-result, delete confirmation (fourth absolute boundary), and the
// saved-page import guide stay here so LedgerPanel can stay focused on the
// spreadsheet + row actions.

import { useCallback, useEffect, useRef, useState } from "react";
import type { SiteLedgerSummary, VisibilityHandoffCredentialView } from "../../../electron/ipc/contract.js";
import type { BatchResultEntry } from "../site-management-batch.js";
import type { CollectionResultModalContent } from "../collection-result-summary.js";
import { Modal } from "./Modal.js";

const guideWallImage = new URL("../assets/saved-page-guide-wall.png", import.meta.url).href;
const guideAccountImage = new URL("../assets/saved-page-guide-account.png", import.meta.url).href;
const CREDENTIAL_CLIPBOARD_CLEAR_MS = 30_000;

export type BatchPhase = "idle" | "running" | "paused" | "canceling" | "done";

export interface BatchProgress {
  phase: BatchPhase;
  queue: string[];
  currentSiteId: string | undefined;
  completed: number;
  results: BatchResultEntry[];
}

export interface HandoffState {
  siteAccountId: string;
  instruction: string;
  fallbackSuggested: boolean;
  credential: VisibilityHandoffCredentialView | undefined;
}

export function BatchCollectionBar({
  selectedCount,
  totalVisible,
  batch,
  currentSiteName,
  disabled,
  onStart,
  onCancel,
  onEnableSessionPersistence,
  sessionPersistenceBulkRunning,
  sessionPersistenceBulkError,
}: {
  selectedCount: number;
  totalVisible: number;
  batch: BatchProgress;
  currentSiteName: string | undefined;
  disabled: boolean;
  onStart: () => void;
  onCancel: () => void;
  onEnableSessionPersistence: () => void;
  sessionPersistenceBulkRunning: boolean;
  sessionPersistenceBulkError: string | undefined;
}): React.JSX.Element {
  const successful = batch.results.filter((entry) => entry.status === "collected").length;
  const failed = batch.results.filter((entry) => entry.status !== "collected").length;
  return (
    <div className="flex flex-col gap-2 rounded border border-neutral-200 p-3">
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          disabled={selectedCount === 0 || disabled}
          onClick={onStart}
          className="rounded bg-neutral-900 px-3 py-1.5 text-sm text-white disabled:cursor-not-allowed disabled:bg-neutral-300"
        >
          選択したサイトを収集
        </button>
        <button
          type="button"
          disabled={selectedCount === 0 || disabled || sessionPersistenceBulkRunning}
          onClick={onEnableSessionPersistence}
          className="rounded border border-neutral-300 px-3 py-1.5 text-sm disabled:cursor-not-allowed disabled:opacity-50"
        >
          {sessionPersistenceBulkRunning ? "設定中…" : "選択したサイトのログインセッションを保持する"}
        </button>
        {disabled && (
          <button type="button" onClick={onCancel} className="text-sm text-red-700 underline">
            一括収集を中止
          </button>
        )}
      </div>
      {sessionPersistenceBulkError && <p className="text-xs text-red-600">{sessionPersistenceBulkError}</p>}
      <p className="text-xs text-neutral-500">
        選択中 {selectedCount} / 表示中 {totalVisible}
        {batch.phase === "running" || batch.phase === "paused"
          ? `。実行中: ${currentSiteName ?? batch.currentSiteId ?? "サイト"}（${batch.completed} / ${batch.queue.length} 件完了）`
          : ""}
        {batch.phase === "canceling" ? "。中止中: 現在の収集が終わるまで待っています" : ""}
        {batch.phase === "done"
          ? `。完了: 成功 ${successful} / 要確認 ${failed}（${batch.completed} / ${batch.queue.length} 件）`
          : ""}
      </p>
    </div>
  );
}

export function CollectionResultModal({
  content,
  onClose,
  onRetry,
  onImportSavedPage,
}: {
  content: CollectionResultModalContent;
  onClose: () => void;
  onRetry: (siteAccountId: string) => void;
  onImportSavedPage: (siteAccountId: string) => void;
}): React.JSX.Element {
  return (
    <Modal title={content.title} onClose={onClose}>
      <ul className="flex flex-col gap-3">
        {content.failures.map((failure) => (
          <li
            key={failure.siteAccountId}
            className="flex flex-col gap-1 rounded border border-neutral-200 p-2"
          >
            <span className="font-medium">{failure.siteName}</span>
            <span className="text-sm text-neutral-700">{failure.reason}</span>
            {(failure.canRetry || failure.canImportSavedPage) && (
              <span className="mt-1 flex flex-wrap gap-2">
                {failure.canRetry && (
                  <button
                    type="button"
                    onClick={() => onRetry(failure.siteAccountId)}
                    className="text-sm underline"
                  >
                    再収集
                  </button>
                )}
                {failure.canImportSavedPage && (
                  <button
                    type="button"
                    onClick={() => onImportSavedPage(failure.siteAccountId)}
                    className="text-sm underline"
                  >
                    保存ページを取り込む
                  </button>
                )}
              </span>
            )}
          </li>
        ))}
      </ul>
      <button
        type="button"
        onClick={onClose}
        className="self-end rounded border border-neutral-300 px-3 py-1.5 text-sm"
      >
        閉じる
      </button>
    </Modal>
  );
}

export function HandoffPanel({
  handoff,
  onResume,
  onSkip,
  onCancelBatch,
  onShowGuide,
}: {
  handoff: HandoffState;
  onResume: () => void;
  onSkip: () => void;
  onCancelBatch: () => void;
  onShowGuide: () => void;
}): React.JSX.Element {
  return (
    <Modal
      title={handoff.fallbackSuggested ? "別の方法で取り込めます" : "ウォールの解決が必要です"}
      onClose={() => undefined}
      dismissible={false}
    >
      <p className="text-sm text-amber-800">{handoff.instruction}</p>
      <p className="text-sm text-neutral-700">
        表示中のブラウザでウォール（CAPTCHA / 認証コード / 確認など）をご自身で解決してください。
        このサイトをスキップしても、一括収集は次のチェック済みサイトへ進みます。
      </p>
      <HandoffCredentialPanel credential={handoff.credential} />
      <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap">
        <button
          type="button"
          onClick={onResume}
          className="rounded bg-neutral-900 px-3 py-1.5 text-sm text-white"
        >
          解決して再開
        </button>
        <button type="button" onClick={onSkip} className="text-sm underline">
          このサイトをスキップ
        </button>
        <button type="button" onClick={onCancelBatch} className="text-sm text-red-700 underline">
          一括収集を中止
        </button>
        <button type="button" onClick={onShowGuide} className="text-sm underline">
          別の方法でこのサイトの情報を取り込む
        </button>
      </div>
    </Modal>
  );
}

function HandoffCredentialPanel({
  credential,
}: {
  credential: VisibilityHandoffCredentialView | undefined;
}): React.JSX.Element {
  if (!credential) {
    return (
      <p className="rounded border border-neutral-200 bg-neutral-50 p-3 text-sm text-neutral-600">
        このステップで表示できるログイン情報はありません。
      </p>
    );
  }
  return (
    <div className="flex flex-col gap-2 rounded border border-neutral-200 bg-neutral-50 p-3">
      <p className="text-sm font-medium text-neutral-900">ログイン補助</p>
      <CopyableCredential label="ログイン ID（メールアドレス）" value={credential.username} />
      <CopyableCredential label="パスワード" value={credential.password} concealed />
    </div>
  );
}

function CopyableCredential({
  label,
  value,
  concealed = false,
}: {
  label: string;
  value: string;
  concealed?: boolean;
}): React.JSX.Element {
  const [copied, setCopied] = useState(false);
  const [revealed, setRevealed] = useState(false);
  const copiedValueRef = useRef<string | undefined>(undefined);
  const clearTimerRef = useRef<number | undefined>(undefined);
  const copiedLabelTimerRef = useRef<number | undefined>(undefined);
  const displayValue = concealed && !revealed ? "••••••••••••" : value;

  const clearCopiedValue = useCallback(async (expectedValue: string) => {
    let shouldClear = false;
    try {
      if (typeof navigator.clipboard.readText !== "function") return;
      const current = await navigator.clipboard.readText();
      shouldClear = current === expectedValue;
    } catch {
      shouldClear = false;
    }
    if (!shouldClear) return;
    try {
      await navigator.clipboard.writeText("");
    } catch {
      // Clipboard permissions differ by platform; failing closed here must not block the hand-off.
    }
  }, []);

  useEffect(() => {
    return () => {
      if (clearTimerRef.current !== undefined) window.clearTimeout(clearTimerRef.current);
      if (copiedLabelTimerRef.current !== undefined) window.clearTimeout(copiedLabelTimerRef.current);
      const copiedValue = copiedValueRef.current;
      if (copiedValue !== undefined) void clearCopiedValue(copiedValue);
    };
  }, [clearCopiedValue]);

  const copy = useCallback(async () => {
    try {
      if (clearTimerRef.current !== undefined) window.clearTimeout(clearTimerRef.current);
      if (copiedLabelTimerRef.current !== undefined) window.clearTimeout(copiedLabelTimerRef.current);
      await navigator.clipboard.writeText(value);
      copiedValueRef.current = value;
      setCopied(true);
      copiedLabelTimerRef.current = window.setTimeout(() => {
        copiedLabelTimerRef.current = undefined;
        setCopied(false);
      }, 2000);
      clearTimerRef.current = window.setTimeout(() => {
        clearTimerRef.current = undefined;
        void clearCopiedValue(value).finally(() => {
          if (copiedValueRef.current === value) copiedValueRef.current = undefined;
        });
      }, CREDENTIAL_CLIPBOARD_CLEAR_MS);
    } catch {
      setCopied(false);
    }
  }, [clearCopiedValue, value]);
  return (
    <div className="flex flex-col gap-1">
      <span className="text-xs font-medium text-neutral-600">{label}</span>
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
        <code className="min-w-0 flex-1 select-all break-all rounded bg-white px-2 py-1 font-mono text-sm">
          {displayValue}
        </code>
        {concealed && (
          <button
            type="button"
            onClick={() => setRevealed((current) => !current)}
            className="rounded border border-neutral-300 px-3 py-1.5 text-sm"
          >
            {revealed ? "隠す" : "表示"}
          </button>
        )}
        <button
          type="button"
          onClick={() => void copy()}
          className="rounded border border-neutral-300 px-3 py-1.5 text-sm"
        >
          {copied ? "コピーしました" : "コピー"}
        </button>
      </div>
    </div>
  );
}

export function DeleteSiteModal({
  site,
  acknowledged,
  deleting,
  onAcknowledgedChange,
  onCancel,
  onConfirm,
}: {
  site: SiteLedgerSummary;
  acknowledged: boolean;
  deleting: boolean;
  onAcknowledgedChange: (checked: boolean) => void;
  onCancel: () => void;
  onConfirm: () => void;
}): React.JSX.Element {
  return (
    <Modal title="サイト情報の削除" onClose={onCancel}>
      <div className="flex flex-col gap-3">
        <p className="text-sm text-neutral-800">
          「{site.displayName}」の情報を Soroeru
          から削除します。ログイン情報・開示・関係・根拠・要確認を含めて削除され、 取り消せません。
        </p>
        <p className="text-sm text-red-700">
          これはサイトからの退会ではなく、Soroeru 内部に保存したこのサイト記録の削除です。
        </p>
        <label className="flex items-start gap-2 text-sm text-neutral-700">
          <input
            type="checkbox"
            checked={acknowledged}
            disabled={deleting}
            onChange={(event) => onAcknowledgedChange(event.target.checked)}
            className="mt-1"
          />
          <span>取り消せない削除であることを確認しました。</span>
        </label>
        <div className="flex flex-col gap-2 sm:flex-row sm:justify-end">
          <button
            type="button"
            disabled={deleting}
            onClick={onCancel}
            className="rounded border border-neutral-300 px-3 py-1.5 text-sm disabled:cursor-not-allowed disabled:opacity-50"
          >
            キャンセル
          </button>
          <button
            type="button"
            disabled={!acknowledged || deleting}
            onClick={onConfirm}
            className="rounded bg-red-700 px-3 py-1.5 text-sm text-white disabled:cursor-not-allowed disabled:bg-neutral-300"
          >
            {deleting ? "削除中…" : "削除する"}
          </button>
        </div>
      </div>
    </Modal>
  );
}

export function SavedPageImportGuide({
  site,
  disabled,
  onOpenSite,
  onSkip,
}: {
  site: SiteLedgerSummary;
  disabled: boolean;
  onOpenSite: () => void;
  onSkip: () => void;
}): React.JSX.Element {
  return (
    <div className="flex flex-col gap-3 rounded border border-neutral-200 bg-white p-3">
      <div className="flex flex-col gap-1">
        <p className="text-sm font-medium">いつものブラウザで保存して取り込む</p>
        <p className="text-xs text-neutral-600">
          Chrome で登録情報のページを開き、HTML のみで保存します。実在サイトのスクリーンショットは使わず、
          この案内はローカルのダミー画面を想定しています。
        </p>
      </div>
      <ol className="grid gap-2 text-xs text-neutral-700 md:grid-cols-4">
        <li className="rounded border border-neutral-200 p-2">
          <span className="font-medium">1. サイトを開く</span>
          <p className="mt-1">既定ブラウザで {site.displayName} を開きます。</p>
        </li>
        <li className="rounded border border-neutral-200 p-2">
          <span className="font-medium">2. 登録情報を表示</span>
          <p className="mt-1">住所、会員情報、アカウント設定などのページを表示します。</p>
        </li>
        <li className="rounded border border-neutral-200 p-2">
          <span className="font-medium">3. HTML のみで保存</span>
          <p className="mt-1">右クリックから別名で保存を選び、形式は「ウェブページ、HTML のみ」にします。</p>
        </li>
        <li className="rounded border border-neutral-200 p-2">
          <span className="font-medium">4. ファイルを取り込む</span>
          <p className="mt-1">下の領域に保存した .html ファイルをドラッグします。</p>
        </li>
      </ol>
      <div className="grid gap-2 md:grid-cols-2">
        <figure className="overflow-hidden rounded border border-neutral-200 bg-neutral-50">
          <img src={guideWallImage} alt="ローカルダミーサイトのセキュリティ確認画面" className="w-full" />
          <figcaption className="px-2 py-1 text-xs text-neutral-500">
            ローカルダミーサイト: セキュリティ確認
          </figcaption>
        </figure>
        <figure className="overflow-hidden rounded border border-neutral-200 bg-neutral-50">
          <img src={guideAccountImage} alt="ローカルダミーサイトの登録情報ページ" className="w-full" />
          <figcaption className="px-2 py-1 text-xs text-neutral-500">
            ローカルダミーサイト: 登録情報ページ
          </figcaption>
        </figure>
      </div>
      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          disabled={disabled}
          onClick={onOpenSite}
          className="rounded bg-neutral-900 px-3 py-1.5 text-sm text-white disabled:cursor-not-allowed disabled:bg-neutral-300"
        >
          このサイトを開く
        </button>
        <button type="button" onClick={onSkip} className="text-sm underline">
          今はスキップ（手動確認に印）
        </button>
      </div>
    </div>
  );
}
