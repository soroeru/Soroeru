// Saved-page scan frame (Issue #569). Runs in its own extension-page realm,
// loaded only by the Side Panel's saved-page renderer. It replaces its own DOM
// with the inert parsed saved page, runs the shared `scanInPage` and value
// readers here (so their `instanceof` checks see this realm's globals), and
// posts the structure-plus-values result back to the panel. The page's CSP
// blocks every network load and every script except this module.

import { scanInPage } from "../src/agent/scan.js";
import { readDisplayValues, readFieldValues } from "../src/automation/saved-page-readers.js";
import { SAVED_PAGE_FRAME_MESSAGES, inertSavedPageDocument } from "./saved-page-frame-protocol.js";

window.addEventListener("message", (event: MessageEvent<unknown>) => {
  if (event.source !== window.parent || event.origin !== location.origin) return;
  const data = event.data as { type?: unknown; nonce?: unknown; html?: unknown } | null;
  if (data?.type !== SAVED_PAGE_FRAME_MESSAGES.render || typeof data.nonce !== "string") return;
  const nonce = data.nonce;
  try {
    if (typeof data.html !== "string") throw new Error("bad-request");
    const parsed = inertSavedPageDocument(data.html, new DOMParser());
    document.head.replaceChildren(...Array.from(parsed.head.childNodes, (node) => document.adoptNode(node)));
    document.body.replaceWith(document.adoptNode(parsed.body));
    const snapshot = { ...scanInPage(), url: "about:blank", title: document.title };
    const result = { snapshot, values: readFieldValues(), displayValues: readDisplayValues() };
    window.parent.postMessage({ type: SAVED_PAGE_FRAME_MESSAGES.rendered, nonce, result }, location.origin);
  } catch {
    window.parent.postMessage({ type: SAVED_PAGE_FRAME_MESSAGES.failed, nonce }, location.origin);
  }
});

window.parent.postMessage({ type: SAVED_PAGE_FRAME_MESSAGES.ready }, location.origin);
