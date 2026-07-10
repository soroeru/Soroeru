import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { decodeNativeMessages, encodeNativeMessage } from "../../native-host/framing.js";
import { createHandshakeToken, readHandshakeToken } from "../../native-host/token.js";
import {
  defaultNativeHostPaths,
  nativeHostIsRegistered,
  registerNativeHost,
  unregisterNativeHost,
} from "../../native-host/registration.js";
import { acceptsHandshakeResponse } from "../../native-host/host.js";
import { ChromeBridgeProtocolError, parseChromeBridgeMessage } from "../../src/shared/chrome-bridge.js";

test("schema accepts known messages and rejects unknown kinds and versions", () => {
  assert.deepEqual(
    parseChromeBridgeMessage({ version: 1, kind: "command", requestId: "r1", command: "snapshot" }),
    {
      version: 1,
      kind: "command",
      requestId: "r1",
      command: "snapshot",
    },
  );
  assert.throws(() => parseChromeBridgeMessage({ version: 1, kind: "future" }), ChromeBridgeProtocolError);
  assert.throws(
    () => parseChromeBridgeMessage({ version: 2, kind: "event", event: "ready" }),
    /unsupported protocol version/,
  );
  assert.throws(
    () => parseChromeBridgeMessage({ version: 1, kind: "event", event: "ready", secret: "must reject" }),
    /unknown field/,
  );
});

test("native messaging framing supports fragmented and coalesced frames", () => {
  const first = encodeNativeMessage({ version: 1, kind: "event", event: "ready" });
  const second = encodeNativeMessage({
    version: 1,
    kind: "result",
    requestId: "r1",
    ok: true,
    payload: { count: 1 },
  });
  const split = decodeNativeMessages(Buffer.concat([first, second.subarray(0, 3)]));
  assert.equal(split.messages.length, 1);
  const rest = decodeNativeMessages(Buffer.concat([split.remainder, second.subarray(3)]));
  assert.equal(rest.messages.length, 1);
  assert.deepEqual(rest.messages[0], {
    version: 1,
    kind: "result",
    requestId: "r1",
    ok: true,
    payload: { count: 1 },
  });
});

test("host rejects a token-mismatch handshake response", () => {
  assert.equal(
    acceptsHandshakeResponse({
      version: 1,
      kind: "result",
      requestId: "native-host-handshake",
      ok: false,
      error: "unauthorized",
    }),
    false,
  );
  assert.equal(
    acceptsHandshakeResponse({ version: 1, kind: "result", requestId: "native-host-handshake", ok: true }),
    true,
  );
  assert.equal(acceptsHandshakeResponse({ version: 1, kind: "result", requestId: "other", ok: true }), false);
});

test("token files are random, validated, and private", async () => {
  const root = await mkdtemp(join(tmpdir(), "soroeru-bridge-"));
  const first = await createHandshakeToken(root);
  const second = await createHandshakeToken(root);
  assert.notEqual(first.token, second.token);
  assert.equal(await readHandshakeToken(second.tokenPath), second.token);
  assert.match(await readFile(second.tokenPath, "utf8"), /^[a-f0-9]{64}\n$/);
});

test("native host registration is idempotent and unregisters its files", async () => {
  const root = await mkdtemp(join(tmpdir(), "soroeru-bridge-"));
  const source = join(root, "host-source");
  await writeFile(source, "fake-host");
  const paths = {
    appSupportDir: join(root, "Application Support"),
    chromeNativeMessagingDir: join(root, "Chrome", "NativeMessagingHosts"),
  };
  const first = await registerNativeHost(source, "a".repeat(32), paths);
  const second = await registerNativeHost(source, "a".repeat(32), paths);
  assert.deepEqual(second, first);
  assert.equal(await nativeHostIsRegistered(paths), true);
  assert.match(
    await readFile(first.manifestPath, "utf8"),
    /chrome-extension:\/\/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\//,
  );
  await unregisterNativeHost(paths);
  assert.equal(await nativeHostIsRegistered(paths), false);
});

test("default native host paths are stable under the macOS application support layout", () => {
  assert.deepEqual(defaultNativeHostPaths("/Users/tester"), {
    appSupportDir: "/Users/tester/Library/Application Support/Soroeru",
    chromeNativeMessagingDir: "/Users/tester/Library/Application Support/Google/Chrome/NativeMessagingHosts",
  });
});
