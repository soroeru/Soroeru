// Vault setup / unlock gate (issue #160, RFC-002 §6). Enforces the shared
// minimum passphrase length as a UI affordance (the trusted layer re-checks it,
// per RFC-002 §3), and offers recovery-key unlock as an alternative path. No
// raw value or vault internal ever reaches here — only sanitized results.
// Shared by the Electron renderer (default: typed preload IPC) and the
// extension Side Panel (Issue #557), which injects `submit`.

import { useCallback, useState } from "react";
import { Label } from "@radix-ui/react-label";
import { MIN_PASSPHRASE_LENGTH } from "../../../electron/ipc/contract.js";
import { reasonMessage } from "../messages.js";

export interface VaultGateRequest {
  kind: "setup" | "unlock" | "recovery";
  /** The passphrase, or the recovery key for `recovery`. Never logged or stored. */
  secret: string;
}

/** Performs the vault action; resolves to a user-facing error message, or `undefined` on success. */
export type VaultGateSubmit = (request: VaultGateRequest) => Promise<string | undefined>;

interface VaultGateProps {
  mode: "setup" | "unlock";
  onSuccess: () => Promise<void> | void;
  submit?: VaultGateSubmit;
}

/** Electron renderer default: the typed preload IPC, with sanitized reason codes. */
const ipcSubmit: VaultGateSubmit = async ({ kind, secret }) => {
  const result =
    kind === "setup"
      ? await window.soroeru.vault.setup(secret)
      : kind === "recovery"
        ? await window.soroeru.vault.unlockWithRecoveryKey(secret)
        : await window.soroeru.vault.unlock(secret);
  return result.ok ? undefined : reasonMessage(result.error);
};

export function VaultGate({
  mode,
  onSuccess,
  submit: performAction = ipcSubmit,
}: VaultGateProps): React.JSX.Element {
  const [passphrase, setPassphrase] = useState("");
  const [recoveryKey, setRecoveryKey] = useState("");
  const [useRecovery, setUseRecovery] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();

  const submit = useCallback(async () => {
    setBusy(true);
    setError(undefined);
    try {
      const failure = await performAction(
        mode === "setup"
          ? { kind: "setup", secret: passphrase }
          : useRecovery
            ? { kind: "recovery", secret: recoveryKey }
            : { kind: "unlock", secret: passphrase },
      );
      if (failure !== undefined) {
        setError(failure);
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
  }, [mode, passphrase, recoveryKey, useRecovery, onSuccess, performAction]);

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
