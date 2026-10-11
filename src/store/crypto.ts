// Encryption primitives for the vault (RFC-001 v3 §9, Q3).
// Argon2id (hash-wasm) -> AES-256-GCM via Web Crypto; PBKDF2-HMAC-SHA-512
// (>= 600k iterations) as the Web-Crypto-only fallback. No custom crypto.
//
// This module holds only the envelope and KDF-parameter logic. Platform
// primitives (random values, SubtleCrypto, Argon2id) come from a
// `CryptoRuntime` (./crypto-runtime.ts), so the same code runs in Node,
// Electron, and the Chrome extension (Issue #556, design #554 §6.2).

import { base64ToBytes, bytesToBase64 } from "./encoding.js";
import { randomBytes, webCryptoRuntime, type CryptoRuntime } from "./crypto-runtime.js";

export type MasterKey = CryptoKey;

export type KdfAlgo = "argon2id" | "pbkdf2-sha512";

export interface KdfParams {
  algo: KdfAlgo;
  /** base64 */
  salt: string;
  /** argon2id */
  iterations: number;
  memorySizeKiB?: number;
  parallelism?: number;
}

export const DEFAULT_ARGON2ID: Omit<KdfParams, "salt"> = {
  algo: "argon2id",
  iterations: 3,
  memorySizeKiB: 64 * 1024,
  parallelism: 1,
};

export const DEFAULT_PBKDF2: Omit<KdfParams, "salt"> = {
  algo: "pbkdf2-sha512",
  iterations: 600_000,
};

export function newKdfParams(algo: KdfAlgo, runtime: CryptoRuntime = webCryptoRuntime): KdfParams {
  const base = algo === "argon2id" ? DEFAULT_ARGON2ID : DEFAULT_PBKDF2;
  return { ...base, salt: bytesToBase64(randomBytes(16, runtime)) };
}

/**
 * Derive the 256-bit master key. The result lives in memory only; never persist it.
 * `extractable: false` yields a key whose raw bytes the platform will not export
 * (the extension Side Panel session, design #554 §6.2).
 */
export async function deriveKey(
  passphrase: string,
  params: KdfParams,
  runtime: CryptoRuntime = webCryptoRuntime,
  extractable = true,
): Promise<MasterKey> {
  const salt = base64ToBytes(params.salt);
  const subtle = runtime.subtle;
  let raw: Uint8Array;
  if (params.algo === "argon2id") {
    raw = await runtime.argon2id({
      password: passphrase,
      salt,
      iterations: params.iterations,
      memorySizeKiB: params.memorySizeKiB ?? DEFAULT_ARGON2ID.memorySizeKiB ?? 65536,
      parallelism: params.parallelism ?? 1,
      hashLength: 32,
    });
  } else {
    const baseKey = await subtle.importKey("raw", new TextEncoder().encode(passphrase), "PBKDF2", false, [
      "deriveBits",
    ]);
    const bits = await subtle.deriveBits(
      { name: "PBKDF2", hash: "SHA-512", salt, iterations: params.iterations },
      baseKey,
      256,
    );
    raw = new Uint8Array(bits);
  }
  // Extractable by default so the master key's raw bytes can be wrapped under a
  // recovery key (SEC-003 / #44); the key itself never leaves this process.
  const keyBytes = new Uint8Array(raw);
  try {
    return await subtle.importKey("raw", keyBytes, { name: "AES-GCM" }, extractable, ["encrypt", "decrypt"]);
  } finally {
    // Best-effort scrub of the raw key copies once the CryptoKey holds them.
    keyBytes.fill(0);
    raw.fill(0);
  }
}

/** Export an AES-GCM key's raw bytes, e.g. to wrap it under another key. */
export async function exportKeyRaw(
  key: MasterKey,
  runtime: CryptoRuntime = webCryptoRuntime,
): Promise<Uint8Array<ArrayBuffer>> {
  return new Uint8Array(await runtime.subtle.exportKey("raw", key));
}

/** Re-import raw AES-GCM key bytes produced by `exportKeyRaw`. */
export async function importKeyRaw(
  raw: Uint8Array,
  extractable = true,
  runtime: CryptoRuntime = webCryptoRuntime,
): Promise<MasterKey> {
  return runtime.subtle.importKey("raw", new Uint8Array(raw), { name: "AES-GCM" }, extractable, [
    "encrypt",
    "decrypt",
  ]);
}

export interface EncryptedRecord {
  /** base64, 96-bit random IV, fresh per record per save (never reused). */
  iv: string;
  /** base64 ciphertext + GCM auth tag. */
  ct: string;
}

export async function encryptRecord(
  key: MasterKey,
  plaintext: string,
  runtime: CryptoRuntime = webCryptoRuntime,
): Promise<EncryptedRecord> {
  const iv = randomBytes(12, runtime);
  const ct = await runtime.subtle.encrypt({ name: "AES-GCM", iv }, key, new TextEncoder().encode(plaintext));
  return { iv: bytesToBase64(iv), ct: bytesToBase64(new Uint8Array(ct)) };
}

export async function decryptRecord(
  key: MasterKey,
  record: EncryptedRecord,
  runtime: CryptoRuntime = webCryptoRuntime,
): Promise<string> {
  const pt = await runtime.subtle.decrypt(
    { name: "AES-GCM", iv: base64ToBytes(record.iv) },
    key,
    base64ToBytes(record.ct),
  );
  return new TextDecoder().decode(pt);
}
