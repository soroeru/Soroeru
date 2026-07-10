import { randomBytes } from "node:crypto";
import { chmod, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";

export async function createHandshakeToken(appSupportDir: string): Promise<{ tokenPath: string; token: string }> {
  const tokenDir = join(appSupportDir, "native-host");
  await mkdir(tokenDir, { recursive: true, mode: 0o700 });
  const tokenPath = join(tokenDir, "bridge-token");
  const token = randomBytes(32).toString("hex");
  const temporaryPath = `${tokenPath}.${process.pid}.tmp`;
  await writeFile(temporaryPath, `${token}\n`, { mode: 0o600 });
  await chmod(temporaryPath, 0o600);
  await rename(temporaryPath, tokenPath);
  return { tokenPath, token };
}

export async function readHandshakeToken(tokenPath: string): Promise<string> {
  const token = (await readFile(tokenPath, "utf8")).trim();
  if (!/^[a-f0-9]{64}$/.test(token)) throw new Error("invalid handshake token");
  return token;
}

export async function removeHandshakeToken(tokenPath: string): Promise<void> {
  await unlink(tokenPath).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  });
}
