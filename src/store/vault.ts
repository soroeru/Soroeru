import { homedir } from "node:os";
import { join } from "node:path";

export const CATASHIRO_APP_SUPPORT_DIR = join(homedir(), "Library", "Application Support", "Catashiro");

export function defaultVaultStateDir(options?: { appBundle?: boolean; override?: string }): string {
  if (options?.override) return options.override;
  return options?.appBundle ? CATASHIRO_APP_SUPPORT_DIR : "state/catashiro-poc";
}
