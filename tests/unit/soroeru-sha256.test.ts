import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { sha256Hex } from "../../src/shared/sha256.js";

test("sha256Hex matches node:crypto across padding boundaries and non-ASCII text", () => {
  const samples = ["", "abc", "a".repeat(55), "a".repeat(56), "a".repeat(63), "a".repeat(64), "a".repeat(1000), "揃える:メール@example.test"];
  for (const sample of samples) {
    assert.equal(sha256Hex(sample), createHash("sha256").update(sample, "utf8").digest("hex"));
  }
});
