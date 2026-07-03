import { randomUUID } from "node:crypto";
import { mkdir, open, rename, unlink } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

export interface AtomicEncryptedStoreWriteOptions {
  readonly mode?: number;
  readonly beforeRename?: (tempPath: string) => Promise<void>;
}

/**
 * Replace a UTF-8 file by writing a same-directory temp file, syncing it, then
 * renaming it over the destination. If the process fails before rename, the
 * previous destination remains intact.
 */
export async function atomicWriteEncryptedStoreFile(
  filePath: string,
  contents: string,
  options: AtomicEncryptedStoreWriteOptions = {},
): Promise<void> {
  const dir = dirname(filePath);
  const tempPath = join(dir, `.${basename(filePath)}.tmp-${process.pid}-${randomUUID()}`);
  const mode = options.mode ?? 0o600;

  await mkdir(dir, { recursive: true });

  let tempExists = false;
  try {
    const handle = await open(tempPath, "wx", mode);
    tempExists = true;
    try {
      // persist: encrypted-store — callers use this helper for encrypted vault JSON only.
      await handle.writeFile(contents, { encoding: "utf8" });
      await handle.sync();
    } finally {
      await handle.close();
    }

    if (options.beforeRename) await options.beforeRename(tempPath);

    await rename(tempPath, filePath);
    tempExists = false;
    await syncDirectoryBestEffort(dir);
  } finally {
    if (tempExists) {
      await unlink(tempPath).catch(() => undefined);
    }
  }
}

async function syncDirectoryBestEffort(dir: string): Promise<void> {
  const handle = await open(dir, "r").catch(() => undefined);
  if (!handle) return;
  try {
    await handle.sync().catch(() => undefined);
  } finally {
    await handle.close();
  }
}
