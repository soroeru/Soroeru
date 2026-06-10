import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, it } from "node:test";
import { JSDOM } from "jsdom";
import { scanFields } from "../../src/content/scanner.js";

async function loadFixture(name: string): Promise<Document> {
  const fixturePath = path.join("tests", "fixtures", "dom", name);
  const html = await readFile(fixturePath, "utf8");
  return new JSDOM(html).window.document;
}

describe("scanFields", () => {
  it("return input, textarea, and select elements", async () => {
    const document = await loadFixture("basic-form.html");
    const fields = scanFields(document);

    const tags = fields.map((field) => field.tag);
    assert.deepEqual(tags.sort(), ["input", "input", "select", "textarea"]);
  });
  it("excludes unsupported input types and buttons", async () => {
    const document = await loadFixture("unsupported-inputs.html");
    const fields = scanFields(document);

    assert.equal(fields.length, 1);
    assert.equal(fields[0]?.tag, "input");
  });
  it("excludes elements that are hidden via CSS", async () => {
    const document = await loadFixture("visibility.html");
    const fields = scanFields(document);

    assert.equal(fields.length, 1);
  });
  it("excludes disabled and readonly elements", async () => {
    const document = await loadFixture("disabled-readonly.html");
    const fields = scanFields(document);

    assert.equal(fields.length, 3);
  });
  it("returns unique scan-local ids in ff-N format", async () => {
    const document = await loadFixture("basic-form.html");
    const fields = scanFields(document);

    const ids = fields.map((field) => field.fieldId);
    assert.equal(new Set(ids).size, ids.length);
    assert.match(ids[0] ?? "", /^ff-\d+$/);
  });
  it("collects label candidates from for, wrapping, aria, and placeholder", async () => {
    const document = await loadFixture("labels.html");
    const fields = scanFields(document);

    const candidates = fields.map((field) => field.labelCandidates);
    assert.deepEqual(candidates, [
      ["Email"],
      ["お名前"],
      ["電話番号"],
      ["住所"],
      ["郵便番号"],
    ]);
  });
});
