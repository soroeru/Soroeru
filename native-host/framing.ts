import {
  ChromeBridgeProtocolError,
  encodeChromeBridgeMessage,
  parseChromeBridgeMessage,
  type ChromeBridgeMessage,
} from "../src/shared/chrome-bridge.js";

export const MAX_NATIVE_MESSAGE_BYTES = 1024 * 1024;

export function encodeNativeMessage(message: ChromeBridgeMessage): Buffer {
  const body = encodeChromeBridgeMessage(message);
  if (body.length > MAX_NATIVE_MESSAGE_BYTES)
    throw new ChromeBridgeProtocolError("message exceeds native messaging limit");
  const header = Buffer.alloc(4);
  header.writeUInt32LE(body.length, 0);
  return Buffer.concat([header, body]);
}

/** Extract complete Native Messaging frames, retaining an incomplete tail. */
export function decodeNativeMessages(buffer: Buffer): { messages: ChromeBridgeMessage[]; remainder: Buffer } {
  const messages: ChromeBridgeMessage[] = [];
  let offset = 0;
  while (buffer.length - offset >= 4) {
    const length = buffer.readUInt32LE(offset);
    if (length > MAX_NATIVE_MESSAGE_BYTES)
      throw new ChromeBridgeProtocolError("native message exceeds limit");
    if (buffer.length - offset - 4 < length) break;
    const body = buffer.subarray(offset + 4, offset + 4 + length);
    let decoded: unknown;
    try {
      decoded = JSON.parse(body.toString("utf8"));
    } catch {
      throw new ChromeBridgeProtocolError("native message is not valid JSON");
    }
    messages.push(parseChromeBridgeMessage(decoded));
    offset += 4 + length;
  }
  return { messages, remainder: buffer.subarray(offset) };
}
