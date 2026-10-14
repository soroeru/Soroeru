// User-facing Japanese messages for Side Panel vault errors (Issue #557).
// Messages never echo error text, which could carry stored or typed values.

import { MIN_PASSPHRASE_LENGTH } from "../electron/ipc/contract.js";
import {
  VaultCorruptError,
  VaultFormatError,
  VaultNoRecoveryKeyError,
  VaultStorageQuotaError,
  VaultUnlockError,
} from "../src/store/vault-errors.js";
import { PassphraseTooShortError, VaultSessionStateError } from "../src/store/vault-session.js";

/** Import failures must say the file was refused and the previous ciphertext remains. */
export function importFailureMessage(err: unknown): string {
  if (err instanceof VaultUnlockError) {
    return "パスフレーズが正しくないため、取り込みを中止しました。以前のデータは残っています。";
  }
  if (err instanceof VaultCorruptError || err instanceof VaultFormatError) {
    return "このファイルは Vault v2 として読み取れないため、取り込みを中止しました。以前のデータは残っています。";
  }
  if (err instanceof VaultStorageQuotaError) {
    return "保存容量が不足しているため、取り込みを中止しました。以前のデータは残っています。";
  }
  if (err instanceof VaultSessionStateError) return vaultErrorMessage(err);
  if (err instanceof Error && err.message.startsWith("refusing to overwrite")) {
    return "置き換えの確認がないため、取り込みを中止しました。以前のデータは残っています。";
  }
  return "取り込みに失敗しました。以前のデータは残っています。";
}

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
  if (err instanceof VaultUnlockError) return "パスフレーズまたはリカバリーキーが正しくありません。";
  if (err instanceof VaultNoRecoveryKeyError) return "この vault にはリカバリーキーが設定されていません。";
  // Record AES-GCM failure: a wrong passphrase on a vault without a verifier, or tampered data.
  if (isNamed(err, "OperationError")) {
    return "解錠できませんでした。パスフレーズが正しくないか、保存データが破損しています。破損している場合は暗号化エクスポートの控えから復元してください。";
  }
  return "処理に失敗しました。もう一度お試しください。";
}

function isNamed(err: unknown, name: string): boolean {
  return typeof err === "object" && err !== null && (err as { name?: unknown }).name === name;
}
