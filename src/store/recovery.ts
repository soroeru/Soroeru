// Recovery key (RFC-001 v3 §9, SEC-003 / #44).
//
// A recovery key is a high-entropy secret, generated locally, shown to the
// user exactly once, and never persisted. It wraps the store's master key
// (see `PocStore.setupRecoveryKey` / `openWithRecoveryKey` in ./store.ts) so
// a forgotten passphrase does not mean lost data, without any third-party
// recovery path (zero-knowledge: nothing here is sent anywhere).

import { createHash, randomBytes } from "node:crypto";
import { importKeyRaw, type MasterKey } from "./crypto.js";

/** 256-bit recovery key: matches the AES-256 master key it wraps. */
const RECOVERY_KEY_BYTES = 32;

/** RFC 4648 base32 alphabet, no padding. */
const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

const GROUP_SIZE = 4;

function base32Encode(bytes: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let out = "";
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32_ALPHABET[(value >>> (bits - 5)) & 0x1f];
      bits -= 5;
    }
  }
  if (bits > 0) out += BASE32_ALPHABET[(value << (5 - bits)) & 0x1f];
  return out;
}

function group(value: string): string {
  const groups: string[] = [];
  for (let i = 0; i < value.length; i += GROUP_SIZE) groups.push(value.slice(i, i + GROUP_SIZE));
  return groups.join("-");
}

/**
 * Generate a new recovery key for one-time display (e.g.
 * `ABCD-EFGH-...-2345`). The caller must show it to the user immediately and
 * not log, screenshot, or send it anywhere; it is not persisted by this
 * function (see `PocStore.setupRecoveryKey`, which wraps the master key with
 * it and persists only the wrapped result).
 */
export function generateRecoveryKey(): string {
  return group(base32Encode(randomBytes(RECOVERY_KEY_BYTES)));
}

/** Strip formatting (hyphens, whitespace, case) so user-entered keys compare correctly. */
export function normalizeRecoveryKey(input: string): string {
  return input.toUpperCase().replace(/[^A-Z2-7]/g, "");
}

/**
 * Derive the key-wrapping key for a recovery key. The recovery key already
 * carries 256 bits of entropy, so a single SHA-256 (not a slow,
 * memory-hard passphrase KDF) is sufficient and keeps recovery unlock fast.
 */
export async function recoveryKeyToKek(recoveryKey: string): Promise<MasterKey> {
  const digest = createHash("sha256").update(normalizeRecoveryKey(recoveryKey), "utf8").digest();
  return importKeyRaw(digest, false);
}
