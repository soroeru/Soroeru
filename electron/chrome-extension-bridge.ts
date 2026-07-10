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
  private readonly sockets = new Set<Socket>();
  private tokenPath: string | undefined;
  private readonly supersededSockets = new WeakSet<Socket>();
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
      await this.closeServer(server);
      await rm(this.options.socketPath, { force: true });
      await removeHandshakeToken(token.tokenPath);
      throw error;
    }
  }

  async close(): Promise<void> {
    if (this.closing) return;
    this.closing = true;
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

  private accept(socket: Socket, expectedToken: string): void {
    this.sockets.add(socket);
    this.emit({ type: "connecting" });
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
        if (remainder.length > MAX_NATIVE_MESSAGE_BYTES + 4) return reject("invalid-message");
        const decoded = decodeNativeMessages(remainder);
        remainder = decoded.remainder;
        for (const message of decoded.messages) {
          if (!authenticated) {
            if (message.kind !== "hello") return reject("invalid-message");
            if (message.token !== expectedToken) return reject("unauthorized");
            authenticated = true;
            if (this.socket && this.socket !== socket) {
              this.supersededSockets.add(this.socket);
              this.socket.destroy();
            }
            this.socket = socket;
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
      if (!rejected && !this.supersededSockets.has(socket))
        this.emit({ type: "rejected", reason: "socket-error" });
      socket.destroy();
    });
    socket.on("close", () => {
      this.sockets.delete(socket);
      if (this.socket === socket) {
        this.socket = undefined;
        if (!this.closing) this.emit({ type: "disconnected" });
      }
    });
  }

  private async closeServer(server: Server | undefined): Promise<void> {
    if (!server || !server.listening) return;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  private async handleCommand(socket: Socket, command: ChromeBridgeCommand): Promise<void> {
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
