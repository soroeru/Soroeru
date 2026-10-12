import assert from "node:assert/strict";
import test from "node:test";
import { resolve } from "node:path";
import { chromium } from "playwright";
import { build } from "vite";
import type { FormSchema, StructureSnapshot } from "../../src/shared/cloud-contract.js";
import type { SchemaReadResult } from "../../src/shared/schema-resolution.js";

test("real browser: sanitized structure, local-only values, classifier validation and pending-page changes", async (t) => {
  const bundle = await build({
    configFile: false,
    logLevel: "silent",
    build: {
      write: false,
      minify: false,
      lib: { entry: resolve("extension/schema-page.ts"), name: "SchemaPage", formats: ["iife"] },
    },
  });
  const output = (Array.isArray(bundle) ? bundle[0] : bundle) as {
    output: { type: string; code?: string }[];
  };
  const code = output.output.find((c) => c.type === "chunk")?.code;
  assert.ok(code);
  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage();
  await page.route("https://example.com/**", (route) =>
    route.fulfill({
      contentType: "text/html",
      body: `<!doctype html><html><head><meta charset="utf-8"></head><body>
    <form><h2>基本情報</h2><label>メールアドレス<input type="email" name="email_fake@example.com" value="fake@example.com"></label>
    <label>パスワード<input type="password" value="fake-secret-password"></label>
    <label>セキュリティコード<input autocomplete="cc-csc" value="123"></label>
    <label>性別<select><option selected value="fake-selected">fake-selected</option></select></label>
    <label>架空花子<input value="fake-ambiguous"></label></form>
    <dl><dt>電話番号</dt><dd>090-0000-0000</dd><dt>架空花子</dt><dd>fake-display-value</dd></dl>
    </body></html>`,
    }),
  );
  type Api = {
    structurePageSnapshot(site: string): StructureSnapshot;
    readSchemaPage(schema: FormSchema): SchemaReadResult;
  };
  const snapshot = async () =>
    page.evaluate(() =>
      (window as unknown as { SchemaPage: Api }).SchemaPage.structurePageSnapshot("example.com"),
    );
  const read = (schema: FormSchema) =>
    page.evaluate(
      (schema) => (window as unknown as { SchemaPage: Api }).SchemaPage.readSchemaPage(schema),
      schema,
    );
  await page.goto("https://example.com/profile");
  await page.addScriptTag({ content: code });
  const structure = await snapshot();
  assert.doesNotMatch(
    JSON.stringify(structure),
    /fake@|090-0000|fake-secret|123|fake-selected|架空花子|fake-ambiguous|fake-display/,
  );
  const email = structure.items.find((i) => i.label === "メールアドレス")!;
  assert.deepEqual(email.valueShape, { length: 16, charClass: "mixed" });
  assert.equal(email.heading, "基本情報");
  for (const item of structure.items.filter(
    (i) => i.label === "パスワード" || i.label === "セキュリティコード" || i.tag === "select",
  ))
    assert.equal(item.valueShape, undefined);
  const schema: FormSchema = {
    schemaId: structure.pageFingerprint,
    site: structure.site,
    formKey: structure.pageFingerprint,
    version: 1,
    pageFingerprints: [structure.pageFingerprint],
    fields: [{ anchor: email.id, attributeKey: "email", required: true }],
    confidence: 0.9,
    status: "candidate",
    provenance: "gemini_structure",
  };
  assert.equal((await read(schema)).values[0]?.value, "fake@example.com");
  await snapshot();
  assert.equal(
    (await read({ ...schema, fields: [{ anchor: email.id, attributeKey: "name.full", required: true }] }))
      .unresolved[0]?.reason,
    "classifier-conflict",
  );
  await snapshot();
  await page.evaluate(() => document.body.appendChild(document.createElement("div")));
  await assert.rejects(read(schema), /stale-structure-page/);
  await snapshot();
  await page.evaluate(() => history.pushState({}, "", "/different"));
  await assert.rejects(read(schema), /stale-structure-page/);
  await page.goto("https://example.com/profile");
  await page.addScriptTag({ content: code });
  await snapshot();
  await page.evaluate(() => document.body.append("私はロボットではありません"));
  await assert.rejects(read(schema), /stale-structure-page/);
  await assert.rejects(snapshot(), /wall-or-page-unavailable/);
});
