// User-facing Japanese messages for Side Panel vault errors (Issue #557).
// Messages never echo error text, which could carry stored or typed values.

import { MIN_PASSPHRASE_LENGTH } from "../electron/ipc/contract.js";
import { VaultCorruptError, VaultFormatError, VaultStorageQuotaError } from "../src/store/vault-errors.js";
import { PassphraseTooShortError, VaultSessionStateError } from "../src/store/vault-session.js";

export function vaultErrorMessage(err: unknown): string {
  if (err instanceof PassphraseTooShortError) {
    return `パスフレーズは${MIN_PASSPHRASE_LENGTH}文字以上で設定してください。`;
  }
  if (err instanceof VaultStorageQuotaError) {
    return "保存できませんでした。ブラウザの保存容量が不足しています。変更は保存されておらず、前の状態が残っています。";
  }
  if (err instanceof VaultCorruptError || err instanceof VaultFormatError) {
    return "保存されている vault を読み取れません。データを上書きしないため、操作を停止しました。暗号化エクスポートの控えから復元してください。";
  }
  if (err instanceof VaultSessionStateError) {
    return err.state === "closed"
      ? "サイドパネルが閉じられたため、操作を中止しました。"
      : "vault の状態が変わりました。画面を開き直してください。";
  }
  // A wrong passphrase or recovery key fails AES-GCM authentication (OperationError).
  if (isNamed(err, "OperationError")) return "パスフレーズまたはリカバリーキーが正しくありません。";
  if (err instanceof Error && err.message === "no recovery key is configured for this vault") {
    return "この vault にはリカバリーキーが設定されていません。";
  }
  return "処理に失敗しました。もう一度お試しください。";
}

function isNamed(err: unknown, name: string): boolean {
  return typeof err === "object" && err !== null && (err as { name?: unknown }).name === name;
}
