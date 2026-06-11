// PoC 共通: autofill 観測の計測ロジック。
// 拡張ページ（poc.js）と content script（content-observer.js）の両方から使う。
//
// プライバシー方針: フィールドの「値」は一切ログに出さない。
// 記録するのはメタデータのみ（イベント種別 / フィールド識別子 / isTrusted /
// inputType / 値の長さ / :autofill 状態）。

(() => {
  "use strict";

  const AUTOFILL_ANIMATION = "ffa-poc-autofill-start";

  function fieldId(el) {
    return (
      el.getAttribute("autocomplete") ||
      el.name ||
      el.id ||
      `${el.tagName.toLowerCase()}#?`
    );
  }

  function matchesAutofill(el) {
    try {
      return el.matches(":autofill") || el.matches(":-webkit-autofill");
    } catch {
      return false;
    }
  }

  // :autofill になった瞬間に animationstart を飛ばす CSS トリック。
  // イベント取り逃がし時の補助シグナル（R3 フォールバック検証）。
  function injectAutofillAnimationStyle(doc) {
    const style = doc.createElement("style");
    style.textContent = [
      `@keyframes ${AUTOFILL_ANIMATION} { from { opacity: 0.999; } to { opacity: 1; } }`,
      `input:-webkit-autofill { animation-name: ${AUTOFILL_ANIMATION}; animation-duration: 0.001s; }`,
    ].join("\n");
    doc.head.appendChild(style);
  }

  // フォーム内の input / textarea / select に観測リスナーを付ける。
  // log(line) は値を含まない1行テキストを受け取る。
  function instrumentFields(root, log) {
    const seenEventFields = new Set();
    const fields = root.querySelectorAll("input, textarea, select");

    for (const el of fields) {
      const id = fieldId(el);

      for (const type of ["input", "change"]) {
        el.addEventListener(type, (ev) => {
          seenEventFields.add(id);
          const inputType = ev.inputType ? ` inputType=${ev.inputType}` : "";
          log(
            `${type}: field=${id} isTrusted=${ev.isTrusted}${inputType}` +
              ` len=${String(el.value ?? "").length} :autofill=${matchesAutofill(el)}`,
          );
        });
      }

      el.addEventListener("focus", () => {
        log(`focus: field=${id} :autofill=${matchesAutofill(el)}`);
      });
      el.addEventListener("blur", () => {
        log(`blur: field=${id} len=${String(el.value ?? "").length} :autofill=${matchesAutofill(el)}`);
      });
    }

    root.addEventListener("animationstart", (ev) => {
      if (ev.animationName !== AUTOFILL_ANIMATION) return;
      const id = fieldId(ev.target);
      log(`animationstart(:autofill): field=${id} (input/changeイベント既出=${seenEventFields.has(id)})`);
    });

    return { seenEventFields };
  }

  // フォールバック検証: :autofill 状態を定期ポーリングし、状態遷移だけをログする。
  // 「イベント無しで :autofill になった」フィールドは取り逃がしの証拠になる。
  function startAutofillPolling(root, log, seenEventFields, intervalMs = 1000) {
    const lastState = new Map();
    const scan = (label) => {
      for (const el of root.querySelectorAll("input, textarea, select")) {
        const id = fieldId(el);
        const now = matchesAutofill(el);
        const before = lastState.get(id) ?? false;
        if (now !== before) {
          const missed = now && !seenEventFields.has(id);
          log(
            `${label}: field=${id} :autofill ${before}->${now}` +
              (missed ? " ※input/changeイベント未観測（取り逃がし）" : ""),
          );
        }
        lastState.set(id, now);
      }
    };
    const timer = setInterval(() => scan("poll"), intervalMs);
    return { rescan: () => scan("manual-rescan"), stop: () => clearInterval(timer) };
  }

  globalThis.FFA_POC = {
    injectAutofillAnimationStyle,
    instrumentFields,
    startAutofillPolling,
  };
})();
