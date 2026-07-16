import { randomUUID } from "node:crypto";
import { chmod, mkdir, rm } from "node:fs/promises";
import { createServer, type Server, type Socket } from "node:net";
import { dirname } from "node:path";
import { createHandshakeToken, removeHandshakeToken } from "../native-host/token.js";
import {
  MAX_NATIVE_MESSAGE_BYTES,
  decodeNativeMessages,
  encodeNativeMessage,
} from "../native-host/framing.js";
import {
  CHROME_BRIDGE_PROTOCOL_VERSION,
  parseChromeBridgeMessage,
  type ChromeBridgeCommand,
  type ChromeBridgeMessage,
  type ChromeBridgeResult,
} from "../src/shared/chrome-bridge.js";
import {
  DEFAULT_EXTENSION_COMMAND_TIMEOUT_MS,
  openExtensionTabSession,
  type ChromeBridgeTransport,
} from "../src/automation/extension-page-driver.js";
import type { SiteSession } from "../src/automation/page-driver.js";

/** Commands that ExtensionPageDriver may dispatch through this bridge. */
export const CHROME_BRIDGE_COMMANDS = [
  "goto",
  "currentUrl",
  "snapshot",
  "readValues",
  "readDisplayValues",
  "fillField",
  "click",
  "waitForReady",
  "unbind",
  "listPermissions",
  "removePermission",
  "activeTab",
  "stop",
] as const;

export type ChromeBridgeCommandName = (typeof CHROME_BRIDGE_COMMANDS)[number];

export type ChromeBridgeRejectionReason =
  "unauthorized" | "invalid-message" | "unknown-command" | "socket-error";

export type ChromeBridgeEventView =
  | { type: "connecting" }
  | { type: "connected" }
  | { type: "disconnected" }
  | { type: "rejected"; reason: ChromeBridgeRejectionReason };

export interface ChromeExtensionBridgeOptions {
  appSupportDir: string;
  socketPath: string;
  /**
   * Optional host→Electron command handler (test/legacy inbound path).
   * Production PageDriver traffic is Electron→extension via `sendCommand`.
   */
  commandHandler?: (
    command: ChromeBridgeCommand,
  ) => Promise<ChromeBridgeMessage | undefined> | ChromeBridgeMessage | undefined;
  onEvent?: (event: ChromeBridgeEventView) => void;
}

interface PendingRequest {
  resolve: (result: ChromeBridgeResult) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

/**
 * Authenticated Electron-side endpoint for the native messaging host.
 *
 * Owns transport, validation, and timed command dispatch for ExtensionPageDriver.
 * Never logs or persists message payloads.
 */
export class ChromeExtensionBridge implements ChromeBridgeTransport {
  private server: Server | undefined;
  private socket: Socket | undefined;
  private readonly sockets = new Set<Socket>();
  private tokenPath: string | undefined;
  private readonly supersededSockets = new WeakSet<Socket>();
  private started = false;
  private closing = false;
  private connected = false;
  private readonly pending = new Map<string, PendingRequest>();
  /** Stop is sticky until a fresh, explicitly confirmed tab session opens. */
  private executionStopped = false;
  /** Serialize outbound commands (1 run · 1 tab · sequential; design §3.5 / §5). */
  private sendChain: Promise<void> = Promise.resolve();

  constructor(private readonly options: ChromeExtensionBridgeOptions) {}

  async start(): Promise<void> {
    if (this.started) return;
    this.closing = false;
    await mkdir(dirname(this.options.socketPath), { recursive: true, mode: 0o700 });
    await chmod(dirname(this.options.socketPath), 0o700);
    await rm(this.options.socketPath, { force: true });
    const token = await createHandshakeToken(this.options.appSupportDir);
    this.tokenPath = token.tokenPath;
    let server: Server | undefined;
    try {
      const listeningServer = createServer((socket) => this.accept(socket, token.token));
      server = listeningServer;
      await new Promise<void>((resolve, reject) => {
        listeningServer.once("error", reject);
        listeningServer.listen(this.options.socketPath, () => {
          listeningServer.removeListener("error", reject);
          resolve();
        });
      });
      await chmod(this.options.socketPath, 0o600);
      this.server = server;
      this.started = true;
      this.emit({ type: "connecting" });
    } catch (error) {
      for (const socket of this.sockets) socket.destroy();
      this.sockets.clear();
      this.socket = undefined;
      this.connected = false;
      await this.closeServer(server);
      await rm(this.options.socketPath, { force: true });
      await removeHandshakeToken(token.tokenPath);
      throw error;
    }
  }

  async close(): Promise<void> {
    if (this.closing) return;
    this.closing = true;
    this.failPending(new Error("chrome bridge disconnected"));
    this.connected = false;
    for (const socket of this.sockets) socket.destroy();
    this.sockets.clear();
    this.socket = undefined;
    const server = this.server;
    this.server = undefined;
    await this.closeServer(server);
    await rm(this.options.socketPath, { force: true });
    if (this.tokenPath) await removeHandshakeToken(this.tokenPath);
    this.tokenPath = undefined;
    this.started = false;
    this.closing = false;
  }

  isConnected(): boolean {
    return this.connected && this.socket !== undefined && !this.socket.destroyed;
  }

  /**
   * Dispatch a PageDriver command to the extension and wait for its result.
   * Commands are serialized; each waits up to `timeoutMs` (default 30s).
   */
  async sendCommand(command: string, payload?: unknown, options?: { timeoutMs?: number }): Promise<unknown> {
    if (!(CHROME_BRIDGE_COMMANDS as readonly string[]).includes(command)) {
      throw new Error(`unknown chrome bridge command: ${command}`);
    }
    const run = this.sendChain.then(() => {
      if (this.executionStopped && isAutomationCommand(command)) {
        throw new Error("chrome bridge execution stopped");
      }
      return this.sendCommandRaw(command, payload, options);
    });
    // Keep the chain alive after rejection so later commands still queue.
    this.sendChain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  /** Emergency shrink path: cancel waiters and bypass the normal command queue. */
  async stopImmediately(): Promise<void> {
    this.executionStopped = true;
    this.failPending(new Error("chrome bridge stopped by user"));
    await this.sendCommandRaw("stop", undefined, { timeoutMs: 5_000 });
  }

  /**
   * Second session factory entry alongside BrowserEngine.openSession.
   * Binds automation to one already-selected tab; close() only unbinds.
   */
  openTabSession(tabId: number, options?: { commandTimeoutMs?: number; siteDomain?: string }): SiteSession {
    this.executionStopped = false;
    return openExtensionTabSession(this, {
      tabId,
      ...(options?.commandTimeoutMs !== undefined ? { commandTimeoutMs: options.commandTimeoutMs } : {}),
      ...(options?.siteDomain === undefined ? {} : { siteDomain: options.siteDomain }),
    });
  }

  private async sendCommandRaw(
    command: string,
    payload: unknown | undefined,
    options?: { timeoutMs?: number },
  ): Promise<unknown> {
    if (!this.isConnected() || !this.socket) {
      throw new Error("chrome bridge not connected");
    }
    const requestId = randomUUID();
    const timeoutMs = options?.timeoutMs ?? DEFAULT_EXTENSION_COMMAND_TIMEOUT_MS;
    const message: ChromeBridgeCommand = {
      version: CHROME_BRIDGE_PROTOCOL_VERSION,
      kind: "command",
      requestId,
      command,
      ...(payload === undefined ? {} : { payload }),
    };
    const result = await new Promise<ChromeBridgeResult>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        // Wording includes "timeout" so VisibilityRunner.unreachableReasonFor maps it.
        const error = new Error(`chrome bridge command timeout: ${command}`);
        // A result may still arrive after this point, but it no longer belongs
        // to a usable command sequence. Tear down the transport before the
        // queue advances so no later command can race that late side effect.
        this.connected = false;
        this.failPending(error);
        this.socket?.destroy();
        reject(error);
      }, timeoutMs);
      this.pending.set(requestId, { resolve, reject, timer });
      try {
        this.socket!.write(encodeNativeMessage(message));
      } catch (err) {
        clearTimeout(timer);
        this.pending.delete(requestId);
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
    if (!result.ok) {
      throw new Error(result.error ?? `chrome bridge command failed: ${command}`);
    }
    return result.payload;
  }

  private accept(socket: Socket, expectedToken: string): void {
    this.sockets.add(socket);
    this.emit({ type: "connecting" });
    let remainder: Buffer<ArrayBufferLike> = Buffer.alloc(0);
    let authenticated = false;
    let rejected = false;

    const reject = (reason: ChromeBridgeRejectionReason): void => {
      if (rejected) return;
      rejected = true;
      // Only tear down pending outbound work when the active authenticated
      // client is the one being rejected (failed replacement must not kill it).
      if (this.socket === socket) {
        this.connected = false;
        this.failPending(new Error("chrome bridge disconnected"));
      }
      if (reason) this.emit({ type: "rejected", reason });
      socket.destroy();
    };

    socket.on("data", (chunk: Buffer) => {
      try {
        remainder = Buffer.concat([remainder, chunk]);
        if (remainder.length > MAX_NATIVE_MESSAGE_BYTES + 4) return reject("invalid-message");
        const decoded = decodeNativeMessages(remainder);
        remainder = decoded.remainder;
        for (const message of decoded.messages) {
          if (!authenticated) {
            if (message.kind !== "hello") return reject("invalid-message");
            if (message.token !== expectedToken) return reject("unauthorized");
            authenticated = true;
            // Promote only after a successful handshake. Fail in-flight commands
            // against the previous active client (if any), then replace it.
            if (this.socket && this.socket !== socket) {
              this.failPending(new Error("chrome bridge disconnected"));
              this.supersededSockets.add(this.socket);
              this.socket.destroy();
            }
            this.socket = socket;
            this.connected = true;
            socket.write(
              encodeNativeMessage({
                version: 1,
                kind: "result",
                requestId: "native-host-handshake",
                ok: true,
              }),
            );
            this.emit({ type: "connected" });
            continue;
          }
          // Bidirectional: Electron may receive results (PageDriver replies),
          // optional host→app commands (tests/legacy), or protocol errors/events.
          if (message.kind === "result") {
            this.resolvePending(message);
            continue;
          }
          if (message.kind === "event") {
            // Connection-state IPC stays sanitized; raw event payloads are not forwarded.
            continue;
          }
          if (message.kind === "error") {
            this.failPending(new Error(message.message || "chrome bridge error"));
            continue;
          }
          if (message.kind !== "command") return reject("invalid-message");
          if (!(CHROME_BRIDGE_COMMANDS as readonly string[]).includes(message.command)) {
            return reject("unknown-command");
          }
          void this.handleInboundCommand(socket, message);
        }
      } catch {
        reject("invalid-message");
      }
    });
    socket.on("error", () => {
      if (!rejected && !this.supersededSockets.has(socket))
        this.emit({ type: "rejected", reason: "socket-error" });
      socket.destroy();
    });
    socket.on("close", () => {
      this.sockets.delete(socket);
      if (this.socket === socket) {
        this.socket = undefined;
        this.connected = false;
        this.failPending(new Error("chrome bridge disconnected"));
        if (!this.closing) this.emit({ type: "disconnected" });
      }
    });
  }

  private async closeServer(server: Server | undefined): Promise<void> {
    if (!server || !server.listening) return;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  private resolvePending(result: ChromeBridgeResult): void {
    const pending = this.pending.get(result.requestId);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pending.delete(result.requestId);
    pending.resolve(result);
  }

  private failPending(error: Error): void {
    for (const [requestId, pending] of this.pending) {
      clearTimeout(pending.timer);
      this.pending.delete(requestId);
      pending.reject(error);
    }
  }

  private async handleInboundCommand(socket: Socket, command: ChromeBridgeCommand): Promise<void> {
    try {
      const response = await this.options.commandHandler?.(command);
      if (!response) {
        socket.write(
          encodeNativeMessage({
            version: 1,
            kind: "result",
            requestId: command.requestId,
            ok: false,
            error: "command handler unavailable",
          }),
        );
        return;
      }
      socket.write(encodeNativeMessage(parseChromeBridgeMessage(response)));
    } catch {
      try {
        socket.write(
          encodeNativeMessage({
            version: 1,
            kind: "result",
            requestId: command.requestId,
            ok: false,
            error: "command failed",
          }),
        );
      } catch {
        socket.destroy();
      }
    }
  }

  private emit(event: ChromeBridgeEventView): void {
    this.options.onEvent?.(event);
  }
}

function isAutomationCommand(command: string): boolean {
  return !["listPermissions", "removePermission", "activeTab", "stop"].includes(command);
}
