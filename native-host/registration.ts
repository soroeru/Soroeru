import { chmod, copyFile, mkdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

export const NATIVE_HOST_NAME = "jp.soroeru.bridge";

export function defaultNativeHostPaths(home = homedir()): NativeHostPaths {
  return {
    appSupportDir: join(home, "Library", "Application Support", "Soroeru"),
    chromeNativeMessagingDir: join(
      home,
      "Library",
      "Application Support",
      "Google",
      "Chrome",
      "NativeMessagingHosts",
    ),
  };
}

export interface NativeHostPaths {
  appSupportDir: string;
  chromeNativeMessagingDir: string;
}

export interface RegistrationResult {
  binaryPath: string;
  manifestPath: string;
}

function validateExtensionId(extensionId: string): void {
  if (!/^[a-p]{32}$/.test(extensionId))
    throw new Error("extensionId must be a 32-character Chrome extension ID");
}

function pathsFor(paths: NativeHostPaths): { hostDir: string; binaryPath: string; manifestPath: string } {
  const hostDir = join(paths.appSupportDir, "native-host");
  return {
    hostDir,
    binaryPath: join(hostDir, NATIVE_HOST_NAME),
    manifestPath: join(paths.chromeNativeMessagingDir, `${NATIVE_HOST_NAME}.json`),
  };
}

/** Install the host outside the .app and publish the manifest only after copying succeeds. */
export async function registerNativeHost(
  sourceBinary: string,
  extensionId: string,
  paths: NativeHostPaths,
): Promise<RegistrationResult> {
  validateExtensionId(extensionId);
  const target = pathsFor(paths);
  await mkdir(target.hostDir, { recursive: true, mode: 0o700 });
  await mkdir(paths.chromeNativeMessagingDir, { recursive: true, mode: 0o700 });
  const temporaryBinary = `${target.binaryPath}.${process.pid}.tmp`;
  const temporaryManifest = `${target.manifestPath}.${process.pid}.tmp`;
  const existingBinary = await stat(target.binaryPath)
    .then(() => true)
    .catch(() => false);
  const existingManifest = await stat(target.manifestPath)
    .then(() => true)
    .catch(() => false);
  try {
    await copyFile(sourceBinary, temporaryBinary);
    await chmod(temporaryBinary, 0o700);
    await rename(temporaryBinary, target.binaryPath);
    const manifest = {
      name: NATIVE_HOST_NAME,
      description: "Soroeru Chrome bridge",
      path: target.binaryPath,
      type: "stdio",
      allowed_origins: [`chrome-extension://${extensionId}/`],
    };
    await writeFile(temporaryManifest, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
    await rename(temporaryManifest, target.manifestPath);
    return { binaryPath: target.binaryPath, manifestPath: target.manifestPath };
  } catch (error) {
    await rm(temporaryBinary, { force: true });
    await rm(temporaryManifest, { force: true });
    if (!existingBinary) await rm(target.binaryPath, { force: true });
    if (!existingManifest) await rm(target.manifestPath, { force: true });
    throw error;
  }
}

export async function unregisterNativeHost(paths: NativeHostPaths): Promise<void> {
  const target = pathsFor(paths);
  await rm(target.manifestPath, { force: true });
  await rm(target.binaryPath, { force: true });
}

export async function nativeHostIsRegistered(paths: NativeHostPaths): Promise<boolean> {
  const target = pathsFor(paths);
  try {
    await Promise.all([stat(target.binaryPath), stat(target.manifestPath)]);
    return true;
  } catch {
    return false;
  }
}
