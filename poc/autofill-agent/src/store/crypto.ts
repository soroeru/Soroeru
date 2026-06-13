// Encryption primitives for the PoC store (RFC-001 v3 §9, Q3).
// Argon2id (hash-wasm) -> AES-256-GCM via Web Crypto; PBKDF2-HMAC-SHA-512
// (>= 600k iterations) as the Web-Crypto-only fallback. No custom crypto.

import { randomBytes } from "node:crypto";
import { webcrypto } from "node:crypto";
import { argon2id } from "hash-wasm";

const subtle = webcrypto.subtle;

// Use Node's webcrypto key type explicitly; the DOM lib also declares CryptoKey
// and the two are not assignable to each other.
export type MasterKey = webcrypto.CryptoKey;

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

export function newKdfParams(algo: KdfAlgo): KdfParams {
  const base = algo === "argon2id" ? DEFAULT_ARGON2ID : DEFAULT_PBKDF2;
  return { ...base, salt: randomBytes(16).toString("base64") };
}

/** Derive the 256-bit master key. The result lives in memory only; never persist it. */
export async function deriveKey(passphrase: string, params: KdfParams): Promise<MasterKey> {
  const salt = Buffer.from(params.salt, "base64");
  let raw: Uint8Array;
  if (params.algo === "argon2id") {
    raw = await argon2id({
      password: passphrase,
      salt,
      iterations: params.iterations,
      memorySize: params.memorySizeKiB ?? DEFAULT_ARGON2ID.memorySizeKiB ?? 65536,
      parallelism: params.parallelism ?? 1,
      hashLength: 32,
      outputType: "binary",
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
  // Extractable so the master key's raw bytes can be wrapped under a recovery
  // key (SEC-003 / #44); the key itself never leaves this process.
  return subtle.importKey("raw", Buffer.from(raw), { name: "AES-GCM" }, true, ["encrypt", "decrypt"]);
}

/** Export an AES-GCM key's raw bytes, e.g. to wrap it under another key. */
export async function exportKeyRaw(key: MasterKey): Promise<Uint8Array> {
  return new Uint8Array(await subtle.exportKey("raw", key));
}

/** Re-import raw AES-GCM key bytes produced by `exportKeyRaw`. */
export async function importKeyRaw(raw: Uint8Array, extractable = true): Promise<MasterKey> {
  return subtle.importKey("raw", Buffer.from(raw), { name: "AES-GCM" }, extractable, ["encrypt", "decrypt"]);
}

export interface EncryptedRecord {
  /** base64, 96-bit random IV, fresh per record per save (never reused). */
  iv: string;
  /** base64 ciphertext + GCM auth tag. */
  ct: string;
}

export async function encryptRecord(key: MasterKey, plaintext: string): Promise<EncryptedRecord> {
  const iv = randomBytes(12);
  const ct = await subtle.encrypt({ name: "AES-GCM", iv }, key, new TextEncoder().encode(plaintext));
  return { iv: iv.toString("base64"), ct: Buffer.from(ct).toString("base64") };
}

export async function decryptRecord(key: MasterKey, record: EncryptedRecord): Promise<string> {
  const pt = await subtle.decrypt(
    { name: "AES-GCM", iv: Buffer.from(record.iv, "base64") },
    key,
    Buffer.from(record.ct, "base64"),
  );
  return new TextDecoder().decode(pt);
}
