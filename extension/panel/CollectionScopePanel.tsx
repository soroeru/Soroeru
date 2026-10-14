import { useState } from "react";
import { FIXED_ATTRIBUTE_LABELS } from "../../src/domain/attribute-labels.js";
import { intersectScope } from "../../src/domain/authorization.js";
import type { CapabilityScope } from "../../src/domain/entities.js";
import type { VisibilityHost } from "./visibility-host.js";

export function CollectionScopePanel({ host, busy }: { host: VisibilityHost; busy: boolean }): React.JSX.Element {
  const [scope, setScope] = useState<CapabilityScope>(() => host.collectionCapability?.scope ?? { siteAccountIds: [], attributeKeys: [] });
  const [enabled, setEnabled] = useState(() => host.collectionCapability?.level === "L1");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  // Lists render only while open so collapsed site names do not duplicate the ledger.
  const [open, setOpen] = useState(false);
  const change = (next: CapabilityScope): void => {
    setScope(next);
    const old = host.collectionCapability?.scope;
    if (!old) return;
    const reduced = intersectScope(old, next);
    if (JSON.stringify(reduced) === JSON.stringify(old)) return;
    // Removing a checkbox revokes immediately, even if new selections remain a draft.
    void host.reduceCollectionScope(reduced).then(() => setEnabled(host.collectionCapability?.level === "L1")).catch(() => setError("縮小は有効ですが保存できませんでした。再試行または暗号化バックアップを行ってください。"));
  };
  const toggle = (part: keyof CapabilityScope, id: string): void => change({ ...scope, [part]: scope[part].includes(id) ? scope[part].filter(v => v !== id) : [...scope[part], id].sort() });
  return <><details className="rounded border p-3" open={open} onToggle={e => setOpen(e.currentTarget.open)}><summary>収集の自動実行範囲（{enabled ? "L1" : "L0"}）</summary>
    {open && <>
    <p>選択したサイトと項目の読み取り、通常の移動、ローカルのログイン入力を許可します。変更・支払い・退会・本人性の表明は含みません。</p>
    <p>認証やアクセス制限、範囲外、取消、ロックで停止します。AI に個人情報を読む許可は別途必要です。再開時はタブを確認してください。</p>
    <fieldset disabled={saving}><legend>サイト</legend>{host.listSites().map(site => <label className="block" key={site.id}><input type="checkbox" checked={scope.siteAccountIds.includes(site.id)} onChange={() => toggle("siteAccountIds", site.id)} />{site.displayName}</label>)}</fieldset>
    <fieldset disabled={saving}><legend>項目</legend>{[...FIXED_ATTRIBUTE_LABELS].filter(([key]) => key !== "account.password" && key !== "card.cvv").map(([key, label]) => <label className="block" key={key}><input type="checkbox" checked={scope.attributeKeys.includes(key)} onChange={() => toggle("attributeKeys", key)} />{label}</label>)}</fieldset>
    <button type="button" disabled={busy || saving || !scope.siteAccountIds.length || !scope.attributeKeys.length} onClick={() => {
      setSaving(true); setError(""); void host.enableCollectionScope(scope).then(() => setEnabled(true)).catch(() => setError("範囲を保存できませんでした。追加した範囲は有効になっていません。")).finally(() => setSaving(false));
    }}>この範囲で L1 を有効にする</button>
    <button type="button" onClick={() => { setEnabled(false); void host.reduceCollectionScope().catch(() => setError("停止は有効ですが保存できませんでした。再試行してください。")); }}>L1 を停止する</button>
    </>}
  </details>
    {error && <><p role="alert">{error}</p><button type="button" onClick={() => { void host.retryAuthorizationSave().then(() => setError("")).catch(() => setError("保存できませんでした。暗号化バックアップを行ってください。")); }}>保存を再試行</button></>}
  </>;
}
