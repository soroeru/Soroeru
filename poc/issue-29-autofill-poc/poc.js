// PoC ページ（R / R2）のロジック。値はログに出さない（メタデータのみ）。
"use strict";

const logEl = document.getElementById("log");

function log(line) {
  const ts = new Date().toISOString().slice(11, 23);
  logEl.textContent += `[${ts}] ${line}\n`;
  logEl.scrollTop = logEl.scrollHeight;
}

log(`PoC start: ${navigator.userAgent}`);

// --- R: chrome.tabs.create ---------------------------------------------

for (const btn of document.querySelectorAll("[data-tabs-create]")) {
  btn.addEventListener("click", async () => {
    const url = btn.dataset.tabsCreate;
    try {
      const tab = await chrome.tabs.create({ url, active: false });
      log(`tabs.create OK: ${url} (tabId=${tab.id})`);
      // 実際にそのURLへ到達したか（即クローズ/エラーページ化していないか）を追跡
      setTimeout(async () => {
        try {
          const t = await chrome.tabs.get(tab.id);
          log(`  -> 800ms後: url=${t.url || t.pendingUrl || "(不明)"} status=${t.status}`);
        } catch (e) {
          log(`  -> 800ms後: タブが消滅 (${e.message})`);
        }
      }, 800);
    } catch (e) {
      log(`tabs.create 失敗: ${url} — ${e.message}`);
    }
  });
}

// --- R: window.open ------------------------------------------------------

document.getElementById("window-open-test").addEventListener("click", () => {
  const url = "chrome://settings/addresses";
  try {
    const w = window.open(url);
    log(`window.open(${url}) -> ${w ? "windowオブジェクト返却（開いたか目視確認）" : "null（ブロック）"}`);
  } catch (e) {
    log(`window.open(${url}) 例外: ${e.message}`);
  }
});

// aタグのクリックも記録（遷移の成否は目視で確認）
for (const a of document.querySelectorAll('a[href^="chrome://"]')) {
  a.addEventListener("click", () => log(`aタグクリック: ${a.getAttribute("href")}（遷移したかは目視確認）`));
}

// --- R2: autofill 観測 ----------------------------------------------------

const form = document.getElementById("r2-form");
FFA_POC.injectAutofillAnimationStyle(document);
const { seenEventFields } = FFA_POC.instrumentFields(form, log);
const polling = FFA_POC.startAutofillPolling(form, log, seenEventFields);

document.getElementById("manual-rescan").addEventListener("click", () => {
  log("--- 手動再スキャン実行 ---");
  polling.rescan();
});

form.addEventListener("submit", () => {
  log("submit: ユーザー操作によるフォーム送信（保存/更新プロンプトの有無を目視確認）");
});

// --- ログ操作 --------------------------------------------------------------

document.getElementById("copy-log").addEventListener("click", async () => {
  await navigator.clipboard.writeText(logEl.textContent);
  log("(ログをクリップボードへコピーしました)");
});
document.getElementById("clear-log").addEventListener("click", () => {
  logEl.textContent = "";
});
