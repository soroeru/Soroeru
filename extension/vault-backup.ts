/** Explicit file selection only; handles are never persisted or used for automatic sync. */
export interface BackupFileHandle {
  createWritable(): Promise<{
    write(data: Blob): Promise<void>;
    close(): Promise<void>;
    abort(): Promise<void>;
  }>;
}

export interface BackupPicker {
  showSaveFilePicker?: (options: {
    suggestedName: string;
    types: Array<{ description: string; accept: Record<string, string[]> }>;
  }) => Promise<BackupFileHandle>;
}

/** `saved` only after the selected file is closed. `download` still needs a user gesture. */
export type VaultBackupResult = { outcome: "saved" } | { outcome: "download"; blob: Blob; name: string };

/**
 * Ask for a destination before serialization, while the click still has transient
 * user activation. A missing picker returns the encrypted blob instead of downloading
 * it here: Argon2id can outlast that activation, so the caller downloads on a later click.
 */
export async function saveVaultBackup(
  picker: BackupPicker,
  exportEncrypted: () => Promise<string>,
): Promise<VaultBackupResult> {
  const name = `soroeru-vault-${new Date().toISOString().slice(0, 10)}.json`;
  const handle = picker.showSaveFilePicker
    ? await picker.showSaveFilePicker({
        suggestedName: name,
        types: [{ description: "Soroeru encrypted vault", accept: { "application/json": [".json"] } }],
      })
    : undefined;
  const blob = new Blob([await exportEncrypted()], { type: "application/json" });
  if (!handle) return { outcome: "download", blob, name };
  const writable = await handle.createWritable();
  try {
    // persist: encrypted-export — only the encrypted Vault v2 document reaches the selected file
    await writable.write(blob);
    await writable.close();
    return { outcome: "saved" };
  } catch (err) {
    await writable.abort().catch(() => undefined);
    throw err;
  }
}
