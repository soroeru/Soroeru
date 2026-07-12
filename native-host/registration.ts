import { access, chmod, mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { homedir } from "node:os";
import { delimiter, isAbsolute, join } from "node:path";

export const NATIVE_HOST_NAME = "jp.soroeru.bridge";

/** Fallbacks for Node installs outside the app's PATH (Homebrew / installer). */
const DEFAULT_NODE_FALLBACKS = ["/usr/local/bin/node", "/opt/homebrew/bin/node", "/usr/bin/node"];

/**
 * Locate an absolute Node.js binary for the installed host's shebang. Chrome
 * launches the host with launchd's minimal PATH (no Homebrew, no nvm), so a
 * `#!/usr/bin/env node` shebang would silently fail on most machines; the
 * installed copy must pin an absolute interpreter path instead.
 */
export async function resolveNodeBinary(
  searchPath = process.env["PATH"] ?? "",
  fallbacks = DEFAULT_NODE_FALLBACKS,
): Promise<string | null> {
  // Only absolute candidates: a shebang interpreter path must be absolute.
  const candidates = [
    ...searchPath.split(delimiter).filter((dir) => isAbsolute(dir)).map((dir) => join(dir, "node")),
    ...fallbacks,
  ];
  for (const candidate of candidates) {
    try {
      await access(candidate, constants.X_OK);
      return candidate;
    } catch {
      // not here; keep looking
    }
  }
  return null;
}

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

/**
 * Install the host outside the .app and publish the manifest only after the
 * copy succeeds. A `#!` shebang in the source is rewritten to an absolute
 * Node path (see resolveNodeBinary); registration fails closed when no Node
 * runtime can be found, instead of installing a host Chrome cannot launch.
 */
export async function registerNativeHost(
  sourceBinary: string,
  extensionId: string,
  paths: NativeHostPaths,
  resolveNode: () => Promise<string | null> = resolveNodeBinary,
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
    const source = await readFile(sourceBinary, "utf8");
    let installed = source;
    if (source.startsWith("#!")) {
      const nodeBinary = await resolveNode();
      if (!nodeBinary)
        throw new Error(
          "Node.js runtime not found: Chrome launches the native host with a minimal PATH, " +
            "so the installed host needs an absolute Node path. Install Node.js " +
            "(e.g. /usr/local/bin/node) and run the connection setup again.",
        );
      installed = `#!${nodeBinary}\n${source.slice(source.indexOf("\n") + 1)}`;
    }
    // persist: native-host-registration
    await writeFile(temporaryBinary, installed, { mode: 0o700 });
    await chmod(temporaryBinary, 0o700);
    await rename(temporaryBinary, target.binaryPath);
    const manifest = {
      name: NATIVE_HOST_NAME,
      description: "Soroeru Chrome bridge",
      path: target.binaryPath,
      type: "stdio",
      allowed_origins: [`chrome-extension://${extensionId}/`],
    };
    // persist: native-host-registration
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
