// Vault setup / unlock gate (issue #160, RFC-002 §6). Enforces the shared
// minimum passphrase length as a UI affordance (the trusted layer re-checks it,
// per RFC-002 §3), and offers recovery-key unlock as an alternative path. No
// raw value or vault internal ever reaches here — only sanitized results.

import { useCallback, useState } from "react";
import { Label } from "@radix-ui/react-label";
import { MIN_PASSPHRASE_LENGTH } from "../../../electron/ipc/contract.js";
import { reasonMessage } from "../messages.js";

interface VaultGateProps {
  mode: "setup" | "unlock";
  onSuccess: () => Promise<void> | void;
}

export function VaultGate({ mode, onSuccess }: VaultGateProps): React.JSX.Element {
  const [passphrase, setPassphrase] = useState("");
  const [recoveryKey, setRecoveryKey] = useState("");
  const [useRecovery, setUseRecovery] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();

  const submit = useCallback(async () => {
    setBusy(true);
    setError(undefined);
    try {
      const result =
        mode === "setup"
          ? await window.soroeru.vault.setup(passphrase)
          : useRecovery
            ? await window.soroeru.vault.unlockWithRecoveryKey(recoveryKey)
            : await window.soroeru.vault.unlock(passphrase);
      if (!result.ok) {
        setError(reasonMessage(result.error));
        return;
      }
      setPassphrase("");
      setRecoveryKey("");
      await onSuccess();
    } catch {
      setError(reasonMessage(undefined));
    } finally {
      setBusy(false);
    }
  }, [mode, passphrase, recoveryKey, useRecovery, onSuccess]);

  const passphraseTooShort = mode === "setup" && passphrase.length < MIN_PASSPHRASE_LENGTH;
  const disabled =
    busy || (useRecovery ? recoveryKey.trim().length === 0 : passphrase.length === 0 || passphraseTooShort);

  return (
    <form
      className="flex flex-col gap-3"
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      {!useRecovery && (
        <>
          <Label htmlFor="passphrase" className="text-sm font-medium">
            {mode === "setup" ? "マスターパスフレーズを設定" : "マスターパスフレーズ"}
          </Label>
          <input
            id="passphrase"
            type="password"
            autoComplete="off"
            value={passphrase}
            onChange={(event) => setPassphrase(event.target.value)}
            className="rounded border border-neutral-300 px-3 py-2"
          />
          {mode === "setup" && (
            <p className="text-xs text-neutral-400">{MIN_PASSPHRASE_LENGTH}文字以上で設定してください。</p>
          )}
        </>
      )}

      {useRecovery && (
        <>
          <Label htmlFor="recovery-key" className="text-sm font-medium">
            リカバリーキー
          </Label>
          <input
            id="recovery-key"
            type="text"
            autoComplete="off"
            spellCheck={false}
            value={recoveryKey}
            onChange={(event) => setRecoveryKey(event.target.value)}
            className="rounded border border-neutral-300 px-3 py-2 font-mono"
          />
        </>
      )}

      <button
        type="submit"
        disabled={disabled}
        className="rounded bg-neutral-900 px-4 py-2 text-white disabled:opacity-50"
      >
        {mode === "setup" ? "作成して解錠" : "解錠"}
      </button>

      {mode === "unlock" && (
        <button
          type="button"
          onClick={() => {
            setUseRecovery((prev) => !prev);
            setError(undefined);
          }}
          className="self-start text-xs text-neutral-500 underline"
        >
          {useRecovery ? "パスフレーズで解錠" : "リカバリーキーで解錠"}
        </button>
      )}

      {error && <p className="text-sm text-red-600">{error}</p>}
    </form>
  );
}
