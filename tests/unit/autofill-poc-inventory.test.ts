// REQ-010 (#16): per-site inventory + authorization mandate. Records hold hashes
// only; the mandate also captures the payment-guard decision for audit.

import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PocStore } from "../../poc/autofill-agent/src/store/store.js";
import { buildMandate } from "../../poc/autofill-agent/src/agent/records.js";
import { paymentAudit } from "../../poc/autofill-agent/src/agent/guards.js";
import type { GuardOutcome } from "../../poc/autofill-agent/src/agent/guards.js";
import type { SiteRecord, TermsAnalysis } from "../../poc/autofill-agent/src/types.js";

const PASSPHRASE = "unit-test-passphrase";

function siteRecord(siteId: string): SiteRecord {
  return {
    origin: `http://127.0.0.1/${siteId}`,
    siteId,
    serviceName: siteId,
    registeredAt: 1,
    filledFields: [
      { profileKey: "email", filledValueHash: "abc123", fieldName: "email", filledAt: 1 },
    ],
    status: "registered",
  };
}

test("inventory API lists, gets, and deletes site records through the store", async () => {
  const dir = await mkdtemp(join(tmpdir(), "af-poc-inv-"));
  const file = join(dir, "store.json");
  try {
    const store = await PocStore.open(file, PASSPHRASE, "pbkdf2-sha512");
    store.upsertSiteRecord(siteRecord("alpha"));
    store.upsertSiteRecord(siteRecord("beta"));
    await store.save();

    const reopened = await PocStore.open(file, PASSPHRASE);
    assert.equal(reopened.listSiteRecords().length, 2);
    assert.equal(reopened.getSiteRecord("alpha")?.serviceName, "alpha");
    assert.equal(reopened.deleteSiteRecord("alpha"), true);
    assert.equal(reopened.deleteSiteRecord("alpha"), false);
    assert.equal(reopened.getSiteRecord("alpha"), undefined);
    assert.equal(reopened.listSiteRecords().length, 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

const clean = (a: Partial<TermsAnalysis>): TermsAnalysis => ({
  highRiskFlags: [],
  evidence: {},
  prohibitsAutoCreation: false,
  ...a,
});

test("mandate records the payment-guard decision and hashes terms text (no raw values)", () => {
  const audit = paymentAudit(
    clean({ payment: "trial-subscription" }),
    true,
    { action: "proceed-submit", fillCard: true, reason: "ok" },
  );
  const mandate = buildMandate(
    {
      origin: "http://127.0.0.1:8080",
      submittedFieldKeys: ["email", "card.number"],
      termsUrl: "http://127.0.0.1:8080/terms",
      termsText: "無料トライアル終了後に課金されます。",
      highRiskFlags: ["trial-subscription"],
      attestationsApproved: [],
      result: "registered",
      audit,
    },
    1000,
  );
  assert.equal(mandate.payment, "trial-subscription");
  assert.equal(mandate.cardFilled, true);
  assert.equal(mandate.paymentStopped, false);
  assert.equal(mandate.authorizedAt, 1000);
  assert.ok(mandate.termsVersionHash && mandate.termsVersionHash.length === 64);
  // The terms text itself is never stored verbatim.
  assert.ok(!JSON.stringify(mandate).includes("無料トライアル終了後に課金されます"));
});

test("payment audit marks a stop-handoff so the mandate documents the payment stop", () => {
  const stop: GuardOutcome = { action: "stop-handoff", fillCard: false, reason: "payment:immediate-payment" };
  const audit = paymentAudit(clean({ payment: "immediate-payment" }), true, stop);
  assert.equal(audit.paymentStopped, true);
  assert.equal(audit.cardFilled, false);
  assert.equal(audit.payment, "immediate-payment");

  const mandate = buildMandate({
    origin: "http://127.0.0.1:8080",
    submittedFieldKeys: ["email"],
    highRiskFlags: [],
    attestationsApproved: [],
    result: "manualHandoff",
    audit,
  });
  assert.equal(mandate.paymentStopped, true);
  assert.equal(mandate.result, "manualHandoff");
});

test("without card fields the mandate omits a payment classification", () => {
  const audit = paymentAudit(clean({}), false, { action: "proceed-submit", fillCard: false, reason: "ok" });
  const mandate = buildMandate({
    origin: "http://127.0.0.1:8080",
    submittedFieldKeys: ["email"],
    highRiskFlags: [],
    attestationsApproved: [],
    result: "registered",
    audit,
  });
  assert.equal(mandate.payment, undefined);
  assert.equal(mandate.cardFilled, false);
});
