// PoC content script（R3）: localhost のフィクスチャページで autofill 発生を観測する。
// オーバーレイにメタデータのみログする（値は記録しない）。
"use strict";

(() => {
  // オーバーレイUI（ホストページのCSSと干渉しないよう inline style のみ）
  const panel = document.createElement("div");
  panel.style.cssText =
    "position:fixed;right:8px;bottom:8px;width:420px;height:260px;z-index:2147483647;" +
    "background:#111;color:#9f9;font:11px/1.5 monospace;border:1px solid #555;" +
    "display:flex;flex-direction:column;";

  const bar = document.createElement("div");
  bar.style.cssText = "background:#333;color:#fff;padding:4px 8px;display:flex;gap:8px;align-items:center;";
  bar.textContent = "formfill PoC observer (R3) ";

  const logBox = document.createElement("div");
  logBox.style.cssText = "flex:1;overflow-y:auto;padding:6px;white-space:pre-wrap;";

  const mkBtn = (label, onClick) => {
    const b = document.createElement("button");
    b.textContent = label;
    b.style.cssText = "font-size:11px;padding:1px 6px;";
    b.addEventListener("click", onClick);
    bar.appendChild(b);
    return b;
  };

  panel.appendChild(bar);
  panel.appendChild(logBox);
  document.documentElement.appendChild(panel);

  function log(line) {
    const ts = new Date().toISOString().slice(11, 23);
    logBox.textContent += `[${ts}] ${line}\n`;
    logBox.scrollTop = logBox.scrollHeight;
  }

  FFA_POC.injectAutofillAnimationStyle(document);
  const { seenEventFields } = FFA_POC.instrumentFields(document, log);
  const polling = FFA_POC.startAutofillPolling(document, log, seenEventFields);

  mkBtn("再スキャン", () => {
    log("--- 手動再スキャン実行 ---");
    polling.rescan();
  });
  mkBtn("コピー", async () => {
    await navigator.clipboard.writeText(logBox.textContent);
    log("(コピーしました)");
  });
  mkBtn("クリア", () => {
    logBox.textContent = "";
  });

  log(`observer 起動: ${location.href}`);
})();
