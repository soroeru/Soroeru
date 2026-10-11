import { createHash, createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import {
  tier3PayloadJson,
  type Tier3TicketRequest,
  type ConsentedReadRequest,
} from "../../src/shared/cloud-contract.js";
interface Claims extends Tier3TicketRequest {
  nonce: string;
  expires: number;
}
export class TicketAuthority {
  private readonly used = new Map<string, number>();
  constructor(
    private readonly secret: string,
    private readonly now = Date.now,
  ) {
    if (!/^[a-f0-9]{64}$/.test(secret)) throw new Error("invalid-ticket-key");
  }
  issue(input: Tier3TicketRequest): { ticket: string; expiresAt: string } {
    const expires = this.now() + 300000;
    const claims: Claims = {
      consentId: input.consentId,
      site: input.site,
      payloadSha256: input.payloadSha256,
      nonce: randomUUID(),
      expires,
    };
    const encoded = Buffer.from(JSON.stringify(claims)).toString("base64url");
    return { ticket: encoded + "." + this.sign(encoded), expiresAt: new Date(expires).toISOString() };
  }
  consume(request: ConsentedReadRequest): boolean {
    try {
      const [encoded, signature] = request.ticket.split(".");
      if (!encoded || !signature) return false;
      const expected = Buffer.from(this.sign(encoded), "base64url");
      const actual = Buffer.from(signature, "base64url");
      if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return false;
      const claims = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")) as Claims;
      const now = this.now();
      if (
        !Number.isSafeInteger(claims.expires) ||
        claims.expires <= now ||
        claims.expires > now + 300000 ||
        typeof claims.nonce !== "string" ||
        claims.site !== request.site ||
        claims.consentId !== request.consentId ||
        claims.payloadSha256 !== createHash("sha256").update(tier3PayloadJson(request)).digest("hex")
      )
        return false;
      for (const [nonce, expires] of this.used) if (expires <= now) this.used.delete(nonce);
      if (this.used.has(claims.nonce) || this.used.size >= 10000) return false;
      this.used.set(claims.nonce, claims.expires);
      return true;
    } catch {
      return false;
    }
  }
  private sign(encoded: string): string {
    return createHmac("sha256", Buffer.from(this.secret, "hex")).update(encoded).digest("base64url");
  }
}
