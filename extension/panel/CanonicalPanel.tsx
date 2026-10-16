import { useState } from "react";
import { FIXED_ATTRIBUTE_LABELS } from "../../src/domain/attribute-labels.js";
import type { VisibilityHost } from "./visibility-host.js";

const fields = [...FIXED_ATTRIBUTE_LABELS].filter(([key]) => !key.startsWith("card.") && key !== "account.password");
export function CanonicalPanel({ host, busy }: { host: VisibilityHost; busy: boolean }): React.JSX.Element {
  const [attributes, setAttributes] = useState(() => host.listCanonicalAttributes());
  const [key, setKey] = useState("name.full");
  const [value, setValue] = useState(() => attributes.find(a => a.attributeKey === "name.full")?.value ?? "");
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState("");
  const current = attributes.find(a => a.attributeKey === key);
  const select = (key: string): void => { setKey(key); setValue(attributes.find(a => a.attributeKey === key)?.value ?? ""); setMessage(""); };
  return <section className="flex flex-col gap-2 rounded border p-3">
    <h2 className="font-semibold">自分の情報</h2>
    <p className="text-xs">本人確認なしで保存できます。入力値は本人確認の証明にはなりません。</p>
    <label>項目<select aria-label="正典の項目" value={key} disabled={busy || saving} onChange={e => select(e.target.value)}>{fields.map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select></label>
    <label>値<input aria-label="正典の値" value={value} disabled={busy || saving} onChange={e => { setValue(e.target.value); setMessage("未保存"); }} /></label>
    <p>{!current ? "未登録" : current.provenance.verification === "verified" ? `検証済み (${current.provenance.method}) ${new Date(current.provenance.verifiedAt).toLocaleDateString()}` : current.provenance.source === "user-entered" ? "ユーザー入力・未検証" : "出所不明・未検証"}</p>
    {current?.provenance.verification === "verified" && <p>編集して保存すると未検証になります。</p>}
    <button type="button" disabled={busy || saving || value === (current?.value ?? "")} onClick={() => {
      setSaving(true);
      void host.saveCanonicalAttribute({ attributeKey: key, label: FIXED_ATTRIBUTE_LABELS.get(key)!, value }).then(() => {
        setAttributes(host.listCanonicalAttributes()); setMessage("保存しました");
      }).catch(() => setMessage("保存できませんでした。入力は未保存です。再試行してください。")).finally(() => setSaving(false));
    }}>保存</button>
    <button type="button" disabled={saving} onClick={() => select(key)}>編集を取り消す</button>
    {message && <p role="status">{message}</p>}
  </section>;
}
