import assert from "node:assert/strict";
import test from "node:test";

import {
  connectionLabel,
  normalizeApprovedOrigins,
  tabConfirmationLabel,
  prepareChromeBridgeRun,
} from "../../src/renderer/chrome-bridge-ui.js";

test("connection labels distinguish unavailable, setup, waiting, and connected states", () => {
  assert.equal(
    connectionLabel({ enabled: false, registered: false, connected: false }),
    "無効（開発者フラグOFF）",
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
