/**
 * Tier 3 consent gate UI (design #554 §5.3).
 *
 * Displayed when Tier 1 and Tier 2 cannot resolve all required attributes and the user must
 * explicitly approve sending a minimal masked page region to Gemini via Soroeru Cloud.
 *
 * Rules enforced by this component:
 * - Nothing is preselected. "送信しない" is the first action and holds focus.
 * - The user may approve only this fallback, or this collection run when the page kind is known.
 * - Times out after `timeoutMs` (default 5 minutes) and resolves as "timeout".
 * - Closing / clicking "送信しない" resolves as "declined".
 */

const PAGE_KIND_LABELS: Record<string, string> = {
  profile: "プロフィール",
  address: "住所",
  payment: "支払い",
  contact: "連絡先",
  security: "セキュリティ",
};

import { useEffect, useRef, useState } from "react";
import type { AttributeKey } from "../../src/shared/cloud-contract.js";
import { PROFILE_FIELD_LABELS } from "../../src/types.js";

export interface ConsentGateProps {
  origin: string;
  attributeKeys: AttributeKey[];
  /** Known page kind. Run approval is hidden when this is absent. */
  pageKind?: string;
  allowRun: boolean;
  requestLimit: number;
  ttlMinutes: number;
  regionLimitKiB: number;
  onSingle: () => void;
  onRun: () => void;
  onDecline: () => void;
  /** Called when the countdown reaches zero. Distinct from onDecline (user action). */
  onTimeout: () => void;
  /** Timeout in milliseconds before the gate auto-resolves as "timeout". Default: 300 000 ms. */
  timeoutMs?: number;
}

/** Display label for a known attribute key. */
function attributeLabel(key: AttributeKey): string {
  return PROFILE_FIELD_LABELS[key] ?? key;
}

export function ConsentGate({
  origin,
  attributeKeys,
  pageKind,
  allowRun,
  requestLimit,
  ttlMinutes,
  regionLimitKiB,
  onSingle,
  onRun,
  onDecline,
  onTimeout,
  timeoutMs = 300_000,
}: ConsentGateProps): React.JSX.Element {
  const [remaining, setRemaining] = useState<number>(Math.ceil(timeoutMs / 1000));
  const resolved = useRef(false);

  useEffect(() => {
    const deadline = Date.now() + timeoutMs;
    const timer = setInterval(() => {
      const left = Math.max(0, Math.ceil((deadline - Date.now()) / 1000));
      setRemaining(left);
      if (left === 0 && !resolved.current) {
        resolved.current = true;
        clearInterval(timer);
        onTimeout(); // UI timer expired: notify host, which resolves as "timeout"
      }
    }, 1000);
    return () => clearInterval(timer);
  }, [timeoutMs, onTimeout]);

  const handleDecline = (): void => {
    if (resolved.current) return;
    resolved.current = true;
    onDecline();
  };

  const choose = (action: () => void): void => {
    if (resolved.current) return;
    resolved.current = true;
    action();
  };

  return (
    <section
      role="dialog"
      aria-modal="true"
      aria-labelledby="consent-gate-title"
      className="flex flex-col gap-3 rounded border border-blue-400 bg-blue-50 p-4"
    >
      <h2 id="consent-gate-title" className="font-semibold text-base">
        Gemini へのページ内容の送信を確認
      </h2>

      <p className="text-sm">
        以下の属性を自動で読み取るために、このページの一部を Soroeru の Google Cloud を経由して Gemini
        に送信してもよいですか？
      </p>

      <dl className="rounded bg-white p-3 text-sm">
        <div className="flex gap-2">
          <dt className="font-medium shrink-0">対象サイト:</dt>
          <dd className="break-all">{origin}</dd>
        </div>
        {pageKind && (
          <div className="flex gap-2 mt-1">
            <dt className="font-medium shrink-0">ページ種別:</dt>
            <dd>{PAGE_KIND_LABELS[pageKind] ?? pageKind}</dd>
          </div>
        )}
        <div className="flex gap-2 mt-1">
          <dt className="font-medium shrink-0">読み取りたい属性:</dt>
          <dd>{attributeKeys.map(attributeLabel).join("、")}</dd>
        </div>
        <div className="flex gap-2 mt-1">
          <dt className="font-medium shrink-0">送信先:</dt>
          <dd>Soroeru Cloud（Google Cloud）経由の Gemini</dd>
        </div>
      </dl>

      <ul className="text-sm list-disc list-inside space-y-1 text-neutral-700">
        <li>パスワード、セキュリティコード、ワンタイムコードなどの秘密情報は送信されません。</li>
        <li>1回の送信は {regionLimitKiB} KiB までです。</li>
        <li>送信した個人情報は改善用データとして保存されません。</li>
        {allowRun ? (
          <li>
            「この収集だけ許可する」は、上のサイト・ページ種別・属性だけに、最大 {requestLimit} 件、承認から {ttlMinutes}{" "}
            分まで有効です。範囲が変わると、再度確認します。
          </li>
        ) : (
          <li>ページ種別を特定できないため、承認できるのはこの1回だけです。</li>
        )}
        <li>収集中の「Gemini への送信を止める」で、残っている承認を取り消せます。</li>
      </ul>

      <p className="text-xs text-neutral-500">残り {remaining} 秒で自動キャンセルされます。</p>
      <p className="text-xs text-neutral-500">
        送信しない場合は、サイトのプロフィールページを開いてから「保存したページを読み込む」機能で手動で読み取ることができます。
      </p>

      <div className="flex flex-col gap-2">
        {/* Nothing is preselected. Decline is first and focused so approval takes an explicit click. */}
        <button
          type="button"
          onClick={handleDecline}
          className="rounded border border-neutral-400 px-3 py-2 text-sm font-medium"
          autoFocus
        >
          送信しない
        </button>
        <button
          type="button"
          onClick={() => choose(onSingle)}
          className="rounded border border-blue-600 px-3 py-2 text-sm font-medium text-blue-700"
        >
          この1回だけ送信する
        </button>
        {allowRun && (
          <button
            type="button"
            onClick={() => choose(onRun)}
            className="rounded bg-blue-600 px-3 py-2 text-sm font-medium text-white"
          >
            この収集だけ許可する
          </button>
        )}
      </div>
    </section>
  );
}
