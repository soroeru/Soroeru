import { randomBytes } from "node:crypto";
import { mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { dirname } from "node:path";

export const CHROME_BRIDGE_SETTINGS_VERSION = 1 as const;

export interface ChromeBridgeStoredSettings {
  version: typeof CHROME_BRIDGE_SETTINGS_VERSION;
  enabled: boolean;
  extensionId: string;
}

export type ChromeBridgeSettingSource = "environment" | "stored" | "default";

export interface ChromeBridgeEffectiveSettings {
  enabled: boolean;
  extensionId: string;
  enabledSource: ChromeBridgeSettingSource;
  extensionIdSource: ChromeBridgeSettingSource;
}

export interface ChromeBridgeResolvedSettings {
  stored: ChromeBridgeStoredSettings;
  effective: ChromeBridgeEffectiveSettings;
  validationError?: "invalid-extension-id";
}

export interface ChromeBridgeSettingsInput {
  enabled: boolean;
  extensionId: string;
}

export interface ChromeBridgeSettingsEnvironment {
  SOROERU_ENABLE_CHROME_BRIDGE?: string;
  SOROERU_CHROME_EXTENSION_ID?: string;
}

const DEFAULT_SETTINGS: ChromeBridgeStoredSettings = {
  version: CHROME_BRIDGE_SETTINGS_VERSION,
  enabled: false,
  extensionId: "",
};

export function isValidChromeExtensionId(value: string): boolean {
  return /^[a-p]{32}$/.test(value);
}

function parseStoredSettings(value: unknown): ChromeBridgeStoredSettings | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (
    record["version"] !== CHROME_BRIDGE_SETTINGS_VERSION ||
    typeof record["enabled"] !== "boolean" ||
    typeof record["extensionId"] !== "string" ||
    (record["extensionId"] !== "" && !isValidChromeExtensionId(record["extensionId"]))
  ) {
    return undefined;
  }
  return {
    version: CHROME_BRIDGE_SETTINGS_VERSION,
    enabled: record["enabled"],
    extensionId: record["extensionId"],
  };
}

export class ChromeBridgeSettingsStore {
  constructor(readonly filePath: string) {}

  async load(): Promise<ChromeBridgeStoredSettings> {
    return (await this.loadWithSource()).settings;
  }

  private async loadWithSource(): Promise<{ settings: ChromeBridgeStoredSettings; present: boolean }> {
    try {
      const parsed = parseStoredSettings(JSON.parse(await readFile(this.filePath, "utf8")));
      return parsed
        ? { settings: parsed, present: true }
        : { settings: { ...DEFAULT_SETTINGS }, present: false };
    } catch {
      return { settings: { ...DEFAULT_SETTINGS }, present: false };
    }
  }

  async resolve(env: ChromeBridgeSettingsEnvironment): Promise<ChromeBridgeResolvedSettings> {
    const loaded = await this.loadWithSource();
    const stored = loaded.settings;
    const enabledEnv = env.SOROERU_ENABLE_CHROME_BRIDGE;
    const idEnv = env.SOROERU_CHROME_EXTENSION_ID;
    const enabledSource: ChromeBridgeSettingSource =
      enabledEnv === undefined ? (loaded.present ? "stored" : "default") : "environment";
    const extensionIdSource: ChromeBridgeSettingSource =
      idEnv === undefined ? (loaded.present ? "stored" : "default") : "environment";
    const requestedEnabled = enabledEnv === undefined ? stored.enabled : enabledEnv === "1";
    const extensionId = idEnv === undefined ? stored.extensionId : idEnv;
    const validId = isValidChromeExtensionId(extensionId);
    const invalidEnabledEnv = enabledEnv !== undefined && enabledEnv !== "0" && enabledEnv !== "1";
    const enabled = requestedEnabled && validId && !invalidEnabledEnv;
    return {
      stored,
      effective: {
        enabled,
        extensionId: validId ? extensionId : "",
        enabledSource,
        extensionIdSource,
      },
      ...((requestedEnabled && !validId) || invalidEnabledEnv
        ? { validationError: "invalid-extension-id" as const }
        : {}),
    };
  }

  async save(input: ChromeBridgeSettingsInput): Promise<ChromeBridgeStoredSettings> {
    if (typeof input.enabled !== "boolean") throw new Error("invalid-enabled");
    if (input.extensionId !== "" && !isValidChromeExtensionId(input.extensionId)) {
      throw new Error("invalid-extension-id");
    }
    if (input.enabled && !isValidChromeExtensionId(input.extensionId)) {
      throw new Error("invalid-extension-id");
    }
    const settings: ChromeBridgeStoredSettings = {
      version: CHROME_BRIDGE_SETTINGS_VERSION,
      enabled: input.enabled,
      extensionId: input.extensionId,
    };
    await mkdir(dirname(this.filePath), { recursive: true });
    const tempPath = `${this.filePath}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
    const handle = await open(tempPath, "wx", 0o600);
    try {
      // persist: extension-connection-metadata — opt-in flag + public extension ID only; never PII.
      await handle.writeFile(JSON.stringify(settings), "utf8");
      await handle.sync();
      await handle.close();
      await rename(tempPath, this.filePath);
    } catch (error) {
      await handle.close().catch(() => undefined);
      await rm(tempPath, { force: true }).catch(() => undefined);
      throw error;
    }
    return settings;
  }
}
