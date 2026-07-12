#!/usr/bin/env node
import { connect } from "node:net";
import { homedir } from "node:os";
import { stdin, stdout } from "node:process";
import { join } from "node:path";
import { readHandshakeToken } from "./token.js";
import { decodeNativeMessages, encodeNativeMessage } from "./framing.js";
import { parseChromeBridgeMessage, type ChromeBridgeMessage } from "../src/shared/chrome-bridge.js";

interface HostOptions {
  socketPath: string;
  tokenPath: string;
}

export function acceptsHandshakeResponse(message: ChromeBridgeMessage): boolean {
  return message.kind === "result" && message.requestId === "native-host-handshake" && message.ok;
}

function optionsFromArgs(args: string[]): HostOptions {
  const defaults = join(homedir(), "Library", "Application Support", "Soroeru", "native-host");
  if (args.length === 0)
    return { socketPath: join(defaults, "bridge.sock"), tokenPath: join(defaults, "bridge-token") };
  const value = (name: string): string => {
    const index = args.indexOf(name);
    const result = index >= 0 ? args[index + 1] : undefined;
    if (!result) throw new Error(`missing ${name}`);
    return result;
  };
  return { socketPath: value("--socket"), tokenPath: value("--token-file") };
}

function writeNative(message: ChromeBridgeMessage): void {
  stdout.write(encodeNativeMessage(message));
}

export async function runNativeHost(options: HostOptions): Promise<void> {
  const token = await readHandshakeToken(options.tokenPath);
  const socket = connect(options.socketPath);
  let stdioRemainder: Buffer<ArrayBufferLike> = Buffer.alloc(0);
  let socketRemainder: Buffer<ArrayBufferLike> = Buffer.alloc(0);
  let handshakeComplete = false;
  const close = (): void => {
    socket.destroy();
    stdout.end();
  };
  socket.on("data", (chunk: Buffer) => {
    try {
      socketRemainder = Buffer.concat([socketRemainder, chunk]);
      const decoded = decodeNativeMessages(socketRemainder);
      socketRemainder = decoded.remainder;
      for (const message of decoded.messages) {
        if (!handshakeComplete) {
          if (!acceptsHandshakeResponse(message)) {
            close();
            return;
          }
          handshakeComplete = true;
        }
        writeNative(message);
      }
    } catch {
      close();
    }
  });
  socket.on("error", () => {
    if (!handshakeComplete)
      writeNative({ version: 1, kind: "error", code: "host-unavailable", message: "Soroeru is not running" });
    close();
  });
  socket.on("close", () => {
    stdout.end();
  });
  socket.on("connect", () => {
    socket.write(encodeNativeMessage({ version: 1, kind: "hello", token }));
  });
  stdin.on("data", (chunk: Buffer) => {
    try {
      stdioRemainder = Buffer.concat([stdioRemainder, chunk]);
      const decoded = decodeNativeMessages(stdioRemainder);
      stdioRemainder = decoded.remainder;
      for (const message of decoded.messages) {
        if (!handshakeComplete) {
          close();
          return;
        }
        parseChromeBridgeMessage(message);
        socket.write(encodeNativeMessage(message));
      }
    } catch {
      close();
    }
  });
  stdin.on("end", close);
  await new Promise<void>((resolve) => socket.once("close", resolve));
}

// Run when invoked directly: as compiled output (host.js), as the bundled
// single file (host.cjs), or as the installed copy Chrome launches
// (jp.soroeru.bridge, see native-host/registration.ts).
const invokedAs = process.argv[1] ?? "";
if (/(?:host\.c?js|jp\.soroeru\.bridge)$/.test(invokedAs)) {
  runNativeHost(optionsFromArgs(process.argv.slice(2))).catch(() => (process.exitCode = 1));
}
