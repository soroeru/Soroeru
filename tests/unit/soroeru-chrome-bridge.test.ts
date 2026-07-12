import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import {
  MAX_NATIVE_MESSAGE_BYTES,
  decodeNativeMessages,
  encodeNativeMessage,
} from "../../native-host/framing.js";
import { createHandshakeToken, readHandshakeToken } from "../../native-host/token.js";
import {
  defaultNativeHostPaths,
  nativeHostIsRegistered,
  registerNativeHost,
  resolveNodeBinary,
  unregisterNativeHost,
} from "../../native-host/registration.js";
import { acceptsHandshakeResponse } from "../../native-host/host.js";
import {
  ChromeBridgeProtocolError,
  encodeChromeBridgeMessage,
  parseChromeBridgeMessage,
  type ChromeBridgeCommand,
} from "../../src/shared/chrome-bridge.js";
import { ChromeExtensionBridge, type ChromeBridgeEventView } from "../../electron/chrome-extension-bridge.js";
import { createChromeExtensionBridge } from "../../electron/chrome-extension-bridge-runtime.js";

function waitForEvent<T>(events: T[], predicate: (event: T) => boolean): Promise<T> {
  const existing = events.find(predicate);
  if (existing) return Promise.resolve(existing);
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("timed out waiting for bridge event")), 1000);
    const timer = setInterval(() => {
      const event = events.find(predicate);
      if (event) {
        clearInterval(timer);
        clearTimeout(timeout);
        resolve(event);
      }
    }, 5);
  });
}

function waitForSocket(socketPath: string): Promise<import("node:net").Socket> {
  return new Promise((resolve, reject) => {
    const socket = connect(socketPath);
    socket.once("connect", () => resolve(socket));
    socket.once("error", reject);
  });
}

function waitForClose(socket: import("node:net").Socket): Promise<void> {
  if (socket.destroyed) return Promise.resolve();
  return new Promise((resolve) => socket.once("close", () => resolve()));
}

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
  const sharedEncoded = encodeChromeBridgeMessage({ version: 1, kind: "event", event: "ready" });
  assert.equal(Buffer.isBuffer(sharedEncoded), false);
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

test("registration pins the installed host's shebang to an absolute Node path", async () => {
  const root = await mkdtemp(join(tmpdir(), "soroeru-bridge-"));
  const source = join(root, "host-source");
  await writeFile(source, "#!/usr/bin/env node\nconsole.log('relay');\n");
  const paths = {
    appSupportDir: join(root, "Application Support"),
    chromeNativeMessagingDir: join(root, "Chrome", "NativeMessagingHosts"),
  };
  const result = await registerNativeHost(source, "a".repeat(32), paths);
  const installed = await readFile(result.binaryPath, "utf8");
  const [shebang, ...rest] = installed.split("\n");
  assert.match(shebang!, /^#!\/.+\/node$/);
  assert.equal(rest.join("\n"), "console.log('relay');\n");
});

test("resolveNodeBinary fails closed when no Node runtime is reachable", async () => {
  assert.equal(await resolveNodeBinary("", []), null);
  const root = await mkdtemp(join(tmpdir(), "soroeru-bridge-"));
  const source = join(root, "host-source");
  await writeFile(source, "#!/usr/bin/env node\nconsole.log('relay');\n");
  // The real resolution should find the Node running this test via PATH or a
  // standard install location; a shebang-less source never needs resolution.
  const paths = {
    appSupportDir: join(root, "Application Support"),
    chromeNativeMessagingDir: join(root, "Chrome", "NativeMessagingHosts"),
  };
  await registerNativeHost(source, "a".repeat(32), paths);
  assert.equal(await nativeHostIsRegistered(paths), true);
});

test("default native host paths are stable under the macOS application support layout", () => {
  assert.deepEqual(defaultNativeHostPaths("/Users/tester"), {
    appSupportDir: "/Users/tester/Library/Application Support/Soroeru",
    chromeNativeMessagingDir: "/Users/tester/Library/Application Support/Google/Chrome/NativeMessagingHosts",
  });
});

test("chrome bridge runtime is off by default and starts when the developer flag is enabled", () => {
  assert.equal(
    createChromeExtensionBridge({
      enabled: false,
      appSupportDir: "/tmp/soroeru",
      socketPath: "/tmp/soroeru/bridge.sock",
    }),
    undefined,
  );
  // Outbound PageDriver dispatch is built into the bridge (Issue #338); no
  // inbound commandHandler is required to create a functional transport.
  const bridge = createChromeExtensionBridge({
    enabled: true,
    appSupportDir: "/tmp/soroeru",
    socketPath: "/tmp/soroeru/bridge.sock",
  });
  assert.ok(bridge);
  assert.equal(bridge.isConnected(), false);
});

test("electron bridge authenticates a host and forwards a validated command result", async () => {
  const root = await mkdtemp(join(tmpdir(), "soroeru-electron-bridge-"));
  const socketPath = join(root, "bridge.sock");
  const events: ChromeBridgeEventView[] = [];
  const bridge = new ChromeExtensionBridge({
    appSupportDir: root,
    socketPath,
    onEvent: (event: ChromeBridgeEventView) => events.push(event),
    commandHandler: (command: ChromeBridgeCommand) => ({
      version: 1,
      kind: "result",
      requestId: command.requestId,
      ok: true,
      payload: { command: command.command },
    }),
  });
  await bridge.start();

  const socket = await waitForSocket(socketPath);
  const token = (await readFile(join(root, "native-host", "bridge-token"), "utf8")).trim();
  socket.write(encodeNativeMessage({ version: 1, kind: "hello", token }));
  socket.write(encodeNativeMessage({ version: 1, kind: "command", requestId: "r1", command: "snapshot" }));

  let remainder: Buffer<ArrayBufferLike> = Buffer.alloc(0);
  const messages = await new Promise<ReturnType<typeof decodeNativeMessages>["messages"]>(
    (resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("timed out waiting for bridge response")), 1000);
      socket.on("data", (chunk: Buffer) => {
        remainder = Buffer.concat([remainder, chunk]);
        const decoded = decodeNativeMessages(remainder);
        remainder = decoded.remainder;
        if (decoded.messages.length >= 2) {
          clearTimeout(timer);
          resolve(decoded.messages);
        }
      });
    },
  );

  assert.deepEqual(messages, [
    { version: 1, kind: "result", requestId: "native-host-handshake", ok: true },
    { version: 1, kind: "result", requestId: "r1", ok: true, payload: { command: "snapshot" } },
  ]);
  assert.deepEqual(await waitForEvent(events, (event) => event.type === "connected"), { type: "connected" });
  socket.destroy();
  await waitForEvent(events, (event) => event.type === "disconnected");
  await bridge.close();
  await assert.rejects(stat(socketPath));
  await assert.rejects(stat(join(root, "native-host", "bridge-token")));
});

test("electron bridge reports an unavailable command handler instead of leaving the client waiting", async () => {
  const root = await mkdtemp(join(tmpdir(), "soroeru-electron-bridge-"));
  const socketPath = join(root, "bridge.sock");
  const bridge = new ChromeExtensionBridge({ appSupportDir: root, socketPath });
  await bridge.start();

  const socket = await waitForSocket(socketPath);
  const token = (await readFile(join(root, "native-host", "bridge-token"), "utf8")).trim();
  socket.write(encodeNativeMessage({ version: 1, kind: "hello", token }));
  socket.write(
    encodeNativeMessage({ version: 1, kind: "command", requestId: "no-handler", command: "snapshot" }),
  );

  let remainder: Buffer<ArrayBufferLike> = Buffer.alloc(0);
  const messages = await new Promise<ReturnType<typeof decodeNativeMessages>["messages"]>(
    (resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("timed out waiting for bridge response")), 1000);
      socket.on("data", (chunk: Buffer) => {
        remainder = Buffer.concat([remainder, chunk]);
        const decoded = decodeNativeMessages(remainder);
        remainder = decoded.remainder;
        if (decoded.messages.length >= 2) {
          clearTimeout(timer);
          resolve(decoded.messages);
        }
      });
    },
  );

  assert.deepEqual(messages[1], {
    version: 1,
    kind: "result",
    requestId: "no-handler",
    ok: false,
    error: "command handler unavailable",
  });
  socket.destroy();
  await bridge.close();
});

test("electron bridge does not report an intentional client replacement as a socket error", async () => {
  const root = await mkdtemp(join(tmpdir(), "soroeru-electron-bridge-"));
  const socketPath = join(root, "bridge.sock");
  const events: ChromeBridgeEventView[] = [];
  const bridge = new ChromeExtensionBridge({
    appSupportDir: root,
    socketPath,
    onEvent: (event: ChromeBridgeEventView) => events.push(event),
  });
  await bridge.start();

  const first = await waitForSocket(socketPath);
  const second = await waitForSocket(socketPath);
  first.emit("error", new Error("superseded client"));

  assert.equal(
    events.some((event) => event.type === "rejected" && event.reason === "socket-error"),
    false,
  );
  second.destroy();
  await bridge.close();
});

test("electron bridge keeps the active client when a replacement fails authentication", async () => {
  const root = await mkdtemp(join(tmpdir(), "soroeru-electron-bridge-"));
  const socketPath = join(root, "bridge.sock");
  const bridge = new ChromeExtensionBridge({
    appSupportDir: root,
    socketPath,
    commandHandler: (command: ChromeBridgeCommand) => ({
      version: 1,
      kind: "result",
      requestId: command.requestId,
      ok: true,
    }),
  });
  await bridge.start();

  const token = (await readFile(join(root, "native-host", "bridge-token"), "utf8")).trim();
  const active = await waitForSocket(socketPath);
  active.write(encodeNativeMessage({ version: 1, kind: "hello", token }));
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("timed out waiting for active handshake")), 1000);
    active.once("data", () => {
      clearTimeout(timer);
      resolve();
    });
  });

  const replacement = await waitForSocket(socketPath);
  replacement.write(encodeNativeMessage({ version: 1, kind: "hello", token: "0".repeat(64) }));
  await waitForClose(replacement);

  active.write(
    encodeNativeMessage({ version: 1, kind: "command", requestId: "still-active", command: "snapshot" }),
  );
  const response = await new Promise<ReturnType<typeof decodeNativeMessages>["messages"]>(
    (resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("timed out waiting for active response")), 1000);
      active.on("data", (chunk: Buffer) => {
        const decoded = decodeNativeMessages(chunk);
        if (
          decoded.messages.some(
            (message) => message.kind === "result" && message.requestId === "still-active",
          )
        ) {
          clearTimeout(timer);
          resolve(decoded.messages);
        }
      });
    },
  );
  assert.equal(
    response.some((message) => message.kind === "result" && message.requestId === "still-active"),
    true,
  );
  active.destroy();
  await bridge.close();
});

test("electron bridge returns a failure result when command handling throws", async () => {
  const root = await mkdtemp(join(tmpdir(), "soroeru-electron-bridge-"));
  const socketPath = join(root, "bridge.sock");
  let calls = 0;
  const bridge = new ChromeExtensionBridge({
    appSupportDir: root,
    socketPath,
    commandHandler: (command: ChromeBridgeCommand) => {
      calls += 1;
      if (calls === 1) throw new Error("handler failure");
      return { version: 1, kind: "result", requestId: command.requestId, ok: true };
    },
  });
  await bridge.start();

  const socket = await waitForSocket(socketPath);
  const token = (await readFile(join(root, "native-host", "bridge-token"), "utf8")).trim();
  socket.write(encodeNativeMessage({ version: 1, kind: "hello", token }));
  socket.write(
    encodeNativeMessage({ version: 1, kind: "command", requestId: "failed", command: "snapshot" }),
  );
  socket.write(
    encodeNativeMessage({ version: 1, kind: "command", requestId: "recovered", command: "snapshot" }),
  );

  let remainder: Buffer<ArrayBufferLike> = Buffer.alloc(0);
  const messages = await new Promise<ReturnType<typeof decodeNativeMessages>["messages"]>(
    (resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("timed out waiting for handler responses")), 1000);
      socket.on("data", (chunk: Buffer) => {
        remainder = Buffer.concat([remainder, chunk]);
        const decoded = decodeNativeMessages(remainder);
        remainder = decoded.remainder;
        if (
          decoded.messages.some((message) => message.kind === "result" && message.requestId === "recovered")
        ) {
          clearTimeout(timer);
          resolve(decoded.messages);
        }
      });
    },
  );
  assert.deepEqual(
    messages.find((message) => message.kind === "result" && message.requestId === "failed"),
    {
      version: 1,
      kind: "result",
      requestId: "failed",
      ok: false,
      error: "command failed",
    },
  );
  assert.deepEqual(
    messages.find((message) => message.kind === "result" && message.requestId === "recovered"),
    {
      version: 1,
      kind: "result",
      requestId: "recovered",
      ok: true,
    },
  );
  socket.destroy();
  await bridge.close();
});

test("electron bridge rejects an oversized incomplete frame buffer", async () => {
  const root = await mkdtemp(join(tmpdir(), "soroeru-electron-bridge-"));
  const socketPath = join(root, "bridge.sock");
  const events: ChromeBridgeEventView[] = [];
  const bridge = new ChromeExtensionBridge({
    appSupportDir: root,
    socketPath,
    onEvent: (event) => events.push(event),
  });
  await bridge.start();

  const socket = await waitForSocket(socketPath);
  const length = Buffer.alloc(4);
  length.writeUInt32LE(MAX_NATIVE_MESSAGE_BYTES, 0);
  socket.write(Buffer.concat([length, Buffer.alloc(MAX_NATIVE_MESSAGE_BYTES + 1)]));
  await waitForEvent(events, (event) => event.type === "rejected" && event.reason === "invalid-message");
  await waitForClose(socket);
  await bridge.close();
});

test("electron bridge sendCommand round-trips a result from the host", async () => {
  const root = await mkdtemp(join(tmpdir(), "soroeru-electron-bridge-send-"));
  const socketPath = join(root, "bridge.sock");
  const events: ChromeBridgeEventView[] = [];
  const bridge = new ChromeExtensionBridge({
    appSupportDir: root,
    socketPath,
    onEvent: (event: ChromeBridgeEventView) => events.push(event),
  });
  await bridge.start();

  const socket = await waitForSocket(socketPath);
  const token = (await readFile(join(root, "native-host", "bridge-token"), "utf8")).trim();
  socket.write(encodeNativeMessage({ version: 1, kind: "hello", token }));
  await waitForEvent(events, (event) => event.type === "connected");
  assert.equal(bridge.isConnected(), true);

  let remainder: Buffer<ArrayBufferLike> = Buffer.alloc(0);
  socket.on("data", (chunk: Buffer) => {
    remainder = Buffer.concat([remainder, chunk]);
    const decoded = decodeNativeMessages(remainder);
    remainder = decoded.remainder;
    for (const message of decoded.messages) {
      if (message.kind === "result" && message.requestId === "native-host-handshake") continue;
      if (message.kind === "command" && (message.command === "snapshot" || message.command === "unbind")) {
        socket.write(
          encodeNativeMessage({
            version: 1,
            kind: "result",
            requestId: message.requestId,
            ok: true,
            ...(message.command === "snapshot"
              ? {
                  payload: {
                    url: "https://example.test/",
                    title: "",
                    fields: [],
                    buttons: [],
                    links: [],
                    visibleText: "",
                    iframeSrcs: [],
                    wallMarkers: [],
                  },
                }
              : {}),
          }),
        );
      }
    }
  });

  const session = bridge.openTabSession(11);
  assert.equal(typeof session.exportStorageState, "undefined");
  const snap = await session.page.snapshot();
  assert.equal(snap.url, "https://example.test/");
  await session.close();
  await assert.rejects(() => session.page.snapshot(), /closed/);

  await bridge.close();
  assert.equal(bridge.isConnected(), false);
});

test("electron bridge sendCommand times out when the host never answers", async () => {
  const root = await mkdtemp(join(tmpdir(), "soroeru-electron-bridge-timeout-"));
  const socketPath = join(root, "bridge.sock");
  const events: ChromeBridgeEventView[] = [];
  const bridge = new ChromeExtensionBridge({
    appSupportDir: root,
    socketPath,
    onEvent: (event: ChromeBridgeEventView) => events.push(event),
  });
  await bridge.start();

  const socket = await waitForSocket(socketPath);
  const token = (await readFile(join(root, "native-host", "bridge-token"), "utf8")).trim();
  socket.write(encodeNativeMessage({ version: 1, kind: "hello", token }));
  await waitForEvent(events, (event) => event.type === "connected");

  await assert.rejects(() => bridge.sendCommand("currentUrl", { tabId: 1 }, { timeoutMs: 30 }), /timeout/);

  socket.destroy();
  await bridge.close();
});

test("immediate stop rejects an in-flight command and blocks commands already queued behind it", async () => {
  const root = await mkdtemp(join(tmpdir(), "soroeru-electron-bridge-stop-"));
  const socketPath = join(root, "bridge.sock");
  const events: ChromeBridgeEventView[] = [];
  const bridge = new ChromeExtensionBridge({
    appSupportDir: root,
    socketPath,
    onEvent: (event) => events.push(event),
  });
  await bridge.start();
  const socket = await waitForSocket(socketPath);
  const token = (await readFile(join(root, "native-host", "bridge-token"), "utf8")).trim();
  socket.write(encodeNativeMessage({ version: 1, kind: "hello", token }));
  await waitForEvent(events, (event) => event.type === "connected");

  const commands: ChromeBridgeCommand[] = [];
  let firstSeenResolve!: () => void;
  const firstSeen = new Promise<void>((resolve) => {
    firstSeenResolve = resolve;
  });
  let remainder: Buffer<ArrayBufferLike> = Buffer.alloc(0);
  socket.on("data", (chunk: Buffer) => {
    remainder = Buffer.concat([remainder, chunk]);
    const decoded = decodeNativeMessages(remainder);
    remainder = decoded.remainder;
    for (const message of decoded.messages) {
      if (message.kind !== "command") continue;
      commands.push(message);
      if (message.command === "snapshot") firstSeenResolve();
      if (message.command === "stop") {
        socket.write(
          encodeNativeMessage({ version: 1, kind: "result", requestId: message.requestId, ok: true }),
        );
      }
    }
  });

  try {
    const inFlight = bridge.sendCommand("snapshot", { tabId: 1 }, { timeoutMs: 5_000 });
    await firstSeen;
    const queued = bridge.sendCommand("click", { tabId: 1, selector: "button" });
    const inFlightRejected = assert.rejects(inFlight, /stopped by user/);
    const queuedRejected = assert.rejects(queued, /execution stopped/);
    await bridge.stopImmediately();
    await Promise.all([inFlightRejected, queuedRejected]);
    assert.deepEqual(
      commands.map((command) => command.command),
      ["snapshot", "stop"],
    );
  } finally {
    socket.destroy();
    await bridge.close();
  }
});

test("electron bridge disconnects after a command timeout so queued commands cannot run", async () => {
  const root = await mkdtemp(join(tmpdir(), "soroeru-electron-bridge-timeout-"));
  const socketPath = join(root, "bridge.sock");
  const events: ChromeBridgeEventView[] = [];
  const bridge = new ChromeExtensionBridge({
    appSupportDir: root,
    socketPath,
    onEvent: (event: ChromeBridgeEventView) => events.push(event),
  });
  await bridge.start();

  const socket = await waitForSocket(socketPath);
  const token = (await readFile(join(root, "native-host", "bridge-token"), "utf8")).trim();
  socket.write(encodeNativeMessage({ version: 1, kind: "hello", token }));
  await waitForEvent(events, (event) => event.type === "connected");

  const commands: ChromeBridgeCommand[] = [];
  let resolveFirstCommand: (() => void) | undefined;
  const firstCommand = new Promise<void>((resolve) => {
    resolveFirstCommand = resolve;
  });
  let remainder: Buffer<ArrayBufferLike> = Buffer.alloc(0);
  socket.on("data", (chunk: Buffer) => {
    remainder = Buffer.concat([remainder, chunk]);
    const decoded = decodeNativeMessages(remainder);
    remainder = decoded.remainder;
    for (const message of decoded.messages) {
      if (message.kind === "command") {
        commands.push(message);
        resolveFirstCommand?.();
      }
    }
  });

  try {
    const timedOut = bridge.sendCommand("snapshot", { tabId: 1 }, { timeoutMs: 30 });
    await firstCommand;
    const queued = bridge.sendCommand("click", { tabId: 1, selector: "button" }, { timeoutMs: 30 });

    await assert.rejects(timedOut, /timeout/);
    await assert.rejects(queued, /not connected/);
    assert.deepEqual(
      commands.map((command) => command.command),
      ["snapshot"],
    );
    assert.equal(bridge.isConnected(), false);
  } finally {
    socket.destroy();
    await bridge.close();
  }
});

test("electron bridge rejects unauthorized and unknown-command clients", async () => {
  const root = await mkdtemp(join(tmpdir(), "soroeru-electron-bridge-"));
  const socketPath = join(root, "bridge.sock");
  const events: ChromeBridgeEventView[] = [];
  const bridge = new ChromeExtensionBridge({
    appSupportDir: root,
    socketPath,
    onEvent: (event: ChromeBridgeEventView) => events.push(event),
  });
  await bridge.start();

  const unauthorized = await waitForSocket(socketPath);
  const unauthorizedClosed = waitForClose(unauthorized);
  unauthorized.write(encodeNativeMessage({ version: 1, kind: "hello", token: "0".repeat(64) }));
  await waitForEvent(events, (event) => event.type === "rejected" && event.reason === "unauthorized");
  await unauthorizedClosed;

  const token = (await readFile(join(root, "native-host", "bridge-token"), "utf8")).trim();
  const unknown = await waitForSocket(socketPath);
  const unknownClosed = waitForClose(unknown);
  unknown.write(encodeNativeMessage({ version: 1, kind: "hello", token }));
  unknown.write(
    encodeNativeMessage({ version: 1, kind: "command", requestId: "r2", command: "deleteEverything" }),
  );
  await waitForEvent(events, (event) => event.type === "rejected" && event.reason === "unknown-command");
  unknown.destroy();
  await unknownClosed;

  await bridge.close();
});
