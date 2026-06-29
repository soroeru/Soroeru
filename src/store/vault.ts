import { access } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

export const SOROERU_APP_SUPPORT_DIR = join(homedir(), "Library", "Application Support", "Soroeru");

export function defaultVaultStateDir(options?: { appBundle?: boolean; override?: string }): string {
  if (options?.override) return options.override;
  return options?.appBundle ? SOROERU_APP_SUPPORT_DIR : "state/soroeru-poc";
}

/** True if an encrypted store file already exists at `storeFilePath` (first-run detection, #79). */
export async function vaultExists(storeFilePath: string): Promise<boolean> {
  try {
    await access(storeFilePath);
    return true;
  } catch {
    return false;
  }
}
