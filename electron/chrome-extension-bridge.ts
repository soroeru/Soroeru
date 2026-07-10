import { chmod, mkdir, rm } from "node:fs/promises";
import { createServer, type Server, type Socket } from "node:net";
import { dirname } from "node:path";
import { createHandshakeToken, removeHandshakeToken } from "../native-host/token.js";
import { decodeNativeMessages, encodeNativeMessage } from "../native-host/framing.js";
import {
  parseChromeBridgeMessage,
  type ChromeBridgeCommand,
  type ChromeBridgeMessage,
} from "../src/shared/chrome-bridge.js";

/** Commands that the future ExtensionPageDriver may dispatch through this bridge. */
export const CHROME_BRIDGE_COMMANDS = [
  "goto",
  "currentUrl",
  "snapshot",
  "readValues",
  "readDisplayValues",
  "fillField",
  "click",
  "waitForReady",
] as const;

export type ChromeBridgeCommandName = (typeof CHROME_BRIDGE_COMMANDS)[number];

export type ChromeBridgeRejectionReason =
  | "unauthorized"
  | "invalid-message"
  | "unknown-command"
  | "socket-error";

export type ChromeBridgeEventView =
  | { type: "connecting" }
  | { type: "connected" }
  | { type: "disconnected" }
  | { type: "rejected"; reason: ChromeBridgeRejectionReason };

export interface ChromeExtensionBridgeOptions {
  appSupportDir: string;
  socketPath: string;
  commandHandler?: (
    command: ChromeBridgeCommand,
  ) => Promise<ChromeBridgeMessage | undefined> | ChromeBridgeMessage | undefined;
  onEvent?: (event: ChromeBridgeEventView) => void;
}

/**
 * Authenticated Electron-side endpoint for the native messaging host.
 *
 * The bridge owns only transport and validation. It never logs or persists
 * message payloads; application behavior is supplied by commandHandler.
 */
export class ChromeExtensionBridge {
  private server: Server | undefined;
  private socket: Socket | undefined;
  private tokenPath: string | undefined;
  private started = false;
  private closing = false;

  constructor(private readonly options: ChromeExtensionBridgeOptions) {}

  async start(): Promise<void> {
    if (this.started) return;
    this.closing = false;
    await mkdir(dirname(this.options.socketPath), { recursive: true, mode: 0o700 });
    await chmod(dirname(this.options.socketPath), 0o700);
    await rm(this.options.socketPath, { force: true });
    const token = await createHandshakeToken(this.options.appSupportDir);
    this.tokenPath = token.tokenPath;
    try {
      const server = createServer((socket) => this.accept(socket, token.token));
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(this.options.socketPath, () => {
          server.removeListener("error", reject);
          resolve();
        });
      });
      await chmod(this.options.socketPath, 0o600);
      this.server = server;
      this.started = true;
      this.emit({ type: "connecting" });
    } catch (error) {
      await removeHandshakeToken(token.tokenPath);
      throw error;
    }
  }

  async close(): Promise<void> {
    if (this.closing) return;
    this.closing = true;
    this.socket?.destroy();
    this.socket = undefined;
    const server = this.server;
    this.server = undefined;
    if (server) {
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
    }
    await rm(this.options.socketPath, { force: true });
    if (this.tokenPath) await removeHandshakeToken(this.tokenPath);
    this.tokenPath = undefined;
    this.started = false;
    this.closing = false;
  }

  private accept(socket: Socket, expectedToken: string): void {
    this.emit({ type: "connecting" });
    this.socket?.destroy();
    this.socket = socket;
    let remainder: Buffer<ArrayBufferLike> = Buffer.alloc(0);
    let authenticated = false;
    let rejected = false;

    const reject = (reason: ChromeBridgeRejectionReason): void => {
      if (rejected) return;
      rejected = true;
      if (reason) this.emit({ type: "rejected", reason });
      socket.destroy();
    };

    socket.on("data", (chunk: Buffer) => {
      try {
        remainder = Buffer.concat([remainder, chunk]);
        const decoded = decodeNativeMessages(remainder);
        remainder = decoded.remainder;
        for (const message of decoded.messages) {
          if (!authenticated) {
            if (message.kind !== "hello") return reject("invalid-message");
            if (message.token !== expectedToken) return reject("unauthorized");
            authenticated = true;
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
          if (message.kind !== "command") return reject("invalid-message");
          if (!(CHROME_BRIDGE_COMMANDS as readonly string[]).includes(message.command)) {
            return reject("unknown-command");
          }
          void this.handleCommand(socket, message);
        }
      } catch {
        reject("invalid-message");
      }
    });
    socket.on("error", () => {
      if (!rejected) this.emit({ type: "rejected", reason: "socket-error" });
      socket.destroy();
    });
    socket.on("close", () => {
      if (this.socket === socket) {
        this.socket = undefined;
        if (!this.closing) this.emit({ type: "disconnected" });
      }
    });
  }

  private async handleCommand(socket: Socket, command: ChromeBridgeCommand): Promise<void> {
    try {
      const response = await this.options.commandHandler?.(command);
      if (response) socket.write(encodeNativeMessage(parseChromeBridgeMessage(response)));
    } catch {
      socket.destroy();
    }
  }

  private emit(event: ChromeBridgeEventView): void {
    this.options.onEvent?.(event);
  }
}
