// Platform crypto runtime for the vault (Issue #556, design #554 §6.2).
//
// Everything here is available in Node (>= 20), Electron, and Chrome extension
// pages through `globalThis.crypto` plus the `hash-wasm` Argon2id build, so the
// envelope / KDF logic in ./crypto.ts never imports `node:` modules or uses
// `Buffer`. The runtime is injectable so tests can observe or stub it.

import { argon2id } from "hash-wasm";

export interface Argon2idParams {
  password: string;
  salt: Uint8Array;
  iterations: number;
  memorySizeKiB: number;
  parallelism: number;
  hashLength: number;
}

export interface CryptoRuntime {
  /** Fill `bytes` with cryptographically secure random values and return it. */
  getRandomValues(bytes: Uint8Array<ArrayBuffer>): Uint8Array<ArrayBuffer>;
  /** RFC 4122 v4 UUID from the platform CSPRNG. */
  randomUUID(): string;
  readonly subtle: SubtleCrypto;
  argon2id(params: Argon2idParams): Promise<Uint8Array>;
}

function platformCrypto(): Crypto {
  const crypto = globalThis.crypto;
  if (!crypto?.subtle || typeof crypto.getRandomValues !== "function") {
    throw new Error("Web Crypto (globalThis.crypto) is not available in this runtime");
  }
  return crypto;
}

/** Default runtime: Web Crypto from `globalThis.crypto`, Argon2id from `hash-wasm`. */
export const webCryptoRuntime: CryptoRuntime = {
  getRandomValues: (bytes) => platformCrypto().getRandomValues(bytes),
  randomUUID: () => platformCrypto().randomUUID(),
  get subtle() {
    return platformCrypto().subtle;
  },
  argon2id: (params) =>
    argon2id({
      password: params.password,
      salt: params.salt,
      iterations: params.iterations,
      memorySize: params.memorySizeKiB,
      parallelism: params.parallelism,
      hashLength: params.hashLength,
      outputType: "binary",
    }),
};

export function randomBytes(length: number, runtime: CryptoRuntime = webCryptoRuntime): Uint8Array<ArrayBuffer> {
  return runtime.getRandomValues(new Uint8Array(length));
}
