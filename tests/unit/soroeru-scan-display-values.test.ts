// Scanner display-value extraction (issue #156 Visibility hardening): account
// pages often render registered info as read-only text (a <dl>, a <table>, or a
// disabled/readonly <input>) rather than editable form fields. The scanner must
// surface these as `displayValues` (label + stamp id only, no raw value) so the
// runner can collect them, while keeping the structure-only snapshot AI-safe.

import assert from "node:assert/strict";
import { test } from "node:test";
import { chromium, type Browser } from "playwright";
import { snapshotPage } from "../../src/agent/scan.js";

const HTML = `<!doctype html><html><body>
  <dl>
    <dt>メールアドレス</dt><dd>old@example.test</dd>
    <dt>電話番号</dt><dd>090-1234-5678</dd>
    <dt>ニュースレター</dt><dd>未登録</dd>
  </dl>
  <table>
    <tr><th>氏名</th><td>山田 太郎</td></tr>
    <tr><th>操作</th><td><button>編集</button></td></tr>
  </table>
  <label for="ro">郵便番号</label>
  <input id="ro" readonly value="150-0001" />
  <input id="pw" type="password" readonly value="should-not-leak" />
</body></html>`;

test("scanner surfaces read-only display values as labels (no raw value in the snapshot)", async () => {
  let browser: Browser | undefined;
  try {
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    await page.setContent(HTML);
    const snapshot = await snapshotPage(page);

    const labels = new Set((snapshot.displayValues ?? []).map((d) => d.labelText));
    // dl email + phone, table 氏名, readonly 郵便番号. Placeholder ("未登録"),
    // a control-bearing td (編集 button), and the password input are excluded.
    assert.deepEqual(labels, new Set(["メールアドレス", "電話番号", "氏名", "郵便番号"]));

    // The displayValues structure carries labels + ids only — never a raw value
    // (the value is read separately and locally via the stamped d-* id). Note that
    // `visibleText` is the page's own innerText by existing design and is not part
    // of this structure-only guarantee.
    const structure = JSON.stringify({ fields: snapshot.fields, displayValues: snapshot.displayValues });
    assert.equal(structure.includes("old@example.test"), false);
    assert.equal(structure.includes("090-1234-5678"), false);
    assert.equal(structure.includes("150-0001"), false);
    assert.equal(structure.includes("should-not-leak"), false);

    // The raw values are readable locally by the stamped d-* ids (the runner path).
    const read = await page.evaluate(() => {
      const out: Record<string, string> = {};
      for (const el of Array.from(document.querySelectorAll("[data-af-id]"))) {
        const id = el.getAttribute("data-af-id");
        if (!id || !id.startsWith("d")) continue;
        const value = el instanceof HTMLInputElement ? el.value : (el.textContent ?? "");
        const trimmed = value.trim();
        if (trimmed !== "") out[id] = trimmed;
      }
      return out;
    });
    const values = Object.values(read).sort();
    assert.deepEqual(values, ["090-1234-5678", "150-0001", "old@example.test", "山田 太郎"]);
    assert.equal(Object.values(read).includes("should-not-leak"), false);
  } finally {
    await browser?.close();
  }
});

test("scanner surfaces read-only display values via sibling layout", async () => {
  let browser: Browser | undefined;
  try {
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    const html = `<!doctype html><html><body>
      <p class="lbl">通常使用する住所</p>
      <p class="val">宮城県仙台市泉区</p>
      <div>
        <span class="lbl-mail">メールアドレス</span>
        <span class="val-mail">test@example.com</span>
      </div>
      <!-- Exclude action verbs and buttons -->
      <button class="btn">住所を追加する</button>
      <div class="val-btn">宮城県仙台市</div>
    </body></html>`;
    await page.setContent(html);
    const snapshot = await snapshotPage(page);

    const labels = (snapshot.displayValues ?? []).map((d) => d.labelText).sort();
    assert.deepEqual(labels, ["メールアドレス", "通常使用する住所"].sort());

    // Read the values locally
    const read = await page.evaluate(() => {
      const out: Record<string, string> = {};
      for (const el of Array.from(document.querySelectorAll("[data-af-id]"))) {
        const id = el.getAttribute("data-af-id");
        if (!id || !id.startsWith("d")) continue;
        const value = el instanceof HTMLInputElement ? el.value : (el.textContent ?? "");
        const trimmed = value.trim();
        if (trimmed !== "") out[id] = trimmed;
      }
      return out;
    });
    const values = Object.values(read).sort();
    assert.deepEqual(values, ["test@example.com", "宮城県仙台市泉区"]);
  } finally {
    await browser?.close();
  }
});

test("scanner extracts inline and nested label-value text without exposing values in the snapshot", async () => {
  let browser: Browser | undefined;
  try {
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    const html = `<!doctype html><html><body>
      <p class="inline">氏名：<span class="value"><strong>山田 太郎</strong></span></p>
      <div class="account-row">
        <div class="key"><span>メールアドレス</span></div>
        <div class="value"><span>nested@example.test</span></div>
      </div>
      <div class="account-row">
        <span aria-label="電話番号"><span>090-1234-5678</span></span>
      </div>
    </body></html>`;
    await page.setContent(html);

    const snapshot = await snapshotPage(page);
    const labels = (snapshot.displayValues ?? []).map((d) => d.labelText).sort();
    assert.deepEqual(labels, ["メールアドレス", "氏名", "電話番号"].sort());

    const structure = JSON.stringify(snapshot.displayValues);
    assert.equal(structure.includes("山田 太郎"), false);
    assert.equal(structure.includes("nested@example.test"), false);
    assert.equal(structure.includes("090-1234-5678"), false);
  } finally {
    await browser?.close();
  }
});
