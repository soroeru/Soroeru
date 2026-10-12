/**
 * Tier 3 consent gate UI (design #554 §5.3).
 *
 * Displayed when Tier 1 and Tier 2 cannot resolve all required attributes and the user must
 * explicitly approve sending a minimal masked page region to Gemini via Soroeru Cloud.
 *
 * Rules enforced by this component:
 * - Default selection is "送信しない" (do not send). No pre-checked state.
 * - Approval is valid for this one fallback only; no "next time auto-approve" option.
 * - Times out after `timeoutMs` (default 5 minutes) and resolves as "timeout".
 * - Closing / clicking "送信しない" resolves as "declined".
 */

import { useEffect, useRef, useState } from "react";
import type { AttributeKey } from "../../src/shared/cloud-contract.js";
import { PROFILE_FIELD_LABELS } from "../../src/types.js";

export interface ConsentGateProps {
  origin: string;
  attributeKeys: AttributeKey[];
  onApprove: () => void;
  onDecline: () => void;
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
  onApprove,
  onDecline,
  timeoutMs = 300_000,
}: ConsentGateProps): React.JSX.Element {
  const [remaining, setRemaining] = useState<number>(Math.ceil(timeoutMs / 1000));
  const declined = useRef(false);

  useEffect(() => {
    const deadline = Date.now() + timeoutMs;
    const timer = setInterval(() => {
      const left = Math.max(0, Math.ceil((deadline - Date.now()) / 1000));
      setRemaining(left);
      if (left === 0 && !declined.current) {
        declined.current = true;
        clearInterval(timer);
        onDecline(); // timeout resolves as decline from the gate's perspective
      }
    }, 1000);
    return () => clearInterval(timer);
  }, [timeoutMs, onDecline]);

  const handleDecline = (): void => {
    if (declined.current) return;
    declined.current = true;
    onDecline();
  };

  const handleApprove = (): void => {
    if (declined.current) return;
    declined.current = true;
    onApprove();
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
        <div className="flex gap-2 mt-1">
          <dt className="font-medium shrink-0">読み取りたい属性:</dt>
          <dd>{attributeKeys.map(attributeLabel).join("、")}</dd>
        </div>
      </dl>

      <ul className="text-sm list-disc list-inside space-y-1 text-neutral-700">
        <li>パスワード・CVV・ワンタイムコードなどの秘密情報は送信されません。</li>
        <li>送信した内容は改善用データとして保存されません。</li>
        <li>承認はこの1回のみ有効です。次回は再度確認します。</li>
        <li>送信先: Soroeru Cloud（Google Cloud）経由の Gemini</li>
      </ul>

      <p className="text-xs text-neutral-500">残り {remaining} 秒で自動キャンセルされます。</p>

      <div className="flex gap-2">
        {/* Default: do not send. Tab order puts decline first so accidental approval is harder. */}
        <button
          type="button"
          onClick={handleDecline}
          className="flex-1 rounded border border-neutral-400 px-3 py-2 text-sm font-medium"
          autoFocus
        >
          送信しない
        </button>
        <button
          type="button"
          onClick={handleApprove}
          className="flex-1 rounded bg-blue-600 px-3 py-2 text-sm font-medium text-white"
        >
          この1回だけ送信する
        </button>
      </div>
    </section>
  );
}
