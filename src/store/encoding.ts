// Byte <-> base64 helpers without `Buffer` (Issue #556), so vault code runs in
// both Node and extension pages. Output is standard RFC 4648 base64 with
// padding — byte-identical to `Buffer#toString("base64")`, which wrote every
// existing Vault v2 file — so stored IVs, ciphertexts, salts, and recovery
// wraps keep the same encoding.

const CHUNK = 0x8000;

export function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

/**
 * Decode canonical standard base64 (padded, no whitespace) — the only form the
 * vault writes. Anything else throws (fail closed) rather than being decoded
 * leniently the way `atob` alone would accept whitespace or missing padding.
 */
export function base64ToBytes(value: string): Uint8Array<ArrayBuffer> {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  if (bytesToBase64(bytes) !== value) throw new SyntaxError("base64 input is not canonical");
  return bytes;
}

/**
 * Compare two byte arrays without an early exit on the first differing byte.
 * Not a guaranteed constant-time primitive: its only caller compares two keys
 * already in this process (`VaultV2.verifyPassphrase`). Do not reuse it to
 * compare secrets across a trust boundary.
 */
export function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= (a[i] ?? 0) ^ (b[i] ?? 0);
  return diff === 0;
}
