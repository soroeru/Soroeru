import assert from "node:assert/strict";
import test from "node:test";

import {
  connectionLabel,
  normalizeApprovedOrigins,
  tabConfirmationLabel,
  prepareChromeBridgeRun,
  chromeBridgeRestartMessage,
  validateChromeExtensionId,
} from "../../src/renderer/chrome-bridge-ui.js";

const VALID_ID = "abcdefghijklmnopabcdefghijklmnop";

test("connection labels distinguish unavailable, setup, waiting, and connected states", () => {
  assert.equal(
    connectionLabel({ enabled: false, registered: false, connected: false }),
    "OFF（起動時設定）",
  );
  assert.equal(connectionLabel({ enabled: true, registered: false, connected: false }), "未登録");
  assert.equal(connectionLabel({ enabled: true, registered: true, connected: false }), "拡張の接続待ち");
  assert.equal(connectionLabel({ enabled: true, registered: true, connected: true }), "接続済み");
});

test("run preparation confirms and selects the current tab only when the bridge is connected", async () => {
  const selected: number[] = [];
  const api = {
    status: async () => ({ enabled: true, registered: true, connected: true }),
    activeTab: async () => ({ tabId: 42, origin: "https://example.test" }),
    selectTab: async (tabId: number) => {
      selected.push(tabId);
      return { ok: true };
    },
  };
  assert.equal(await prepareChromeBridgeRun(api, () => true), true);
  assert.deepEqual(selected, [42]);
  assert.equal(await prepareChromeBridgeRun(api, () => false), false);
  assert.deepEqual(selected, [42]);
});

test("approved origins are HTTPS-only, deduplicated, and sorted without paths", () => {
  assert.deepEqual(
    normalizeApprovedOrigins([
      "https://b.example/*",
      "http://unsafe.example/*",
      "https://a.example/*",
      "https://b.example/*",
      "not-a-url",
    ]),
    ["https://a.example", "https://b.example"],
  );
});

test("tab confirmation text contains only masked tab metadata", () => {
  assert.equal(
    tabConfirmationLabel({ tabId: 42, origin: "https://example.test" }),
    "https://example.test（タブ 42）",
  );
});

test("settings validation requires a strict Chrome extension ID only when enabling", () => {
  assert.equal(validateChromeExtensionId(true, VALID_ID), undefined);
  assert.equal(validateChromeExtensionId(true, ""), "32文字の拡張ID（a〜pの小文字）を入力してください。");
  assert.equal(validateChromeExtensionId(false, ""), undefined);
  assert.equal(validateChromeExtensionId(false, "invalid"), "32文字の拡張ID（a〜pの小文字）を入力してください。");
});

test("restart copy distinguishes the running listener from the next startup setting", () => {
  assert.equal(
    chromeBridgeRestartMessage(true, false),
    "接続リスナーを停止しました。再起動すると Chrome 拡張ブリッジは OFF で起動します。",
  );
  assert.equal(
    chromeBridgeRestartMessage(false, true),
    "現在のプロセスではまだ OFF です。再起動すると Chrome 拡張ブリッジが ON になります。",
  );
  assert.equal(
    chromeBridgeRestartMessage(true, true),
    "拡張IDの変更は再起動後に反映されます。現在の接続は再起動まで以前のIDを使用します。",
  );
});
