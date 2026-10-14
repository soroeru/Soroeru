// Side Panel renderer for the saved-page import (Issue #569): loads the
// extension's CSP-locked scan frame off-screen, hands it the saved HTML, and
// resolves with the scanned structure and values. One frame per import, removed
// afterwards. Replaces Electron's headless Playwright renderer.

import type { RenderedSavedPage, SavedPageRenderer } from "../../src/automation/saved-page-core.js";
import { SAVED_PAGE_FRAME_MESSAGES } from "../saved-page-frame-protocol.js";

const DEFAULT_TIMEOUT_MS = 15_000;

export interface FrameRendererEnvironment {
  document: Document;
  window: Pick<Window, "addEventListener" | "removeEventListener">;
  origin: string;
  frameUrl: string;
  createNonce: () => string;
  timeoutMs?: number;
}

export function createFrameSavedPageRenderer(env: FrameRendererEnvironment): SavedPageRenderer {
  return (html) =>
    new Promise<RenderedSavedPage>((resolve, reject) => {
      const frame = env.document.createElement("iframe");
      const nonce = env.createNonce();
      frame.setAttribute("aria-hidden", "true");
      frame.tabIndex = -1;
      // Off-screen but laid out: `scanInPage` skips elements without client rects.
      frame.style.cssText = "position:fixed;left:-20000px;top:0;width:1280px;height:800px;border:0;";
      const finish = (): void => {
        env.window.removeEventListener("message", onMessage);
        clearTimeout(timer);
        frame.remove();
      };
      const onMessage = (event: MessageEvent<unknown>): void => {
        if (event.source !== frame.contentWindow || event.origin !== env.origin) return;
        const data = event.data as { type?: unknown; nonce?: unknown; result?: unknown } | null;
        if (data?.type === SAVED_PAGE_FRAME_MESSAGES.ready) {
          frame.contentWindow?.postMessage(
            { type: SAVED_PAGE_FRAME_MESSAGES.render, nonce, html },
            env.origin,
          );
          return;
        }
        if (data?.nonce !== nonce) return;
        if (data.type === SAVED_PAGE_FRAME_MESSAGES.rendered && isRenderedSavedPage(data.result)) {
          finish();
          resolve(data.result);
        } else if (
          data.type === SAVED_PAGE_FRAME_MESSAGES.failed ||
          data.type === SAVED_PAGE_FRAME_MESSAGES.rendered
        ) {
          finish();
          reject(new Error("saved-page-render-failed"));
        }
      };
      const timer = setTimeout(() => {
        finish();
        reject(new Error("saved-page-render-timeout"));
      }, env.timeoutMs ?? DEFAULT_TIMEOUT_MS);
      env.window.addEventListener("message", onMessage);
      frame.src = env.frameUrl;
      env.document.body.append(frame);
    });
}

function isRenderedSavedPage(value: unknown): value is RenderedSavedPage {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<RenderedSavedPage>;
  return (
    !!candidate.snapshot &&
    Array.isArray(candidate.snapshot.fields) &&
    isStringRecord(candidate.values) &&
    isStringRecord(candidate.displayValues)
  );
}

function isStringRecord(value: unknown): value is Record<string, string> {
  return (
    !!value && typeof value === "object" && Object.values(value).every((entry) => typeof entry === "string")
  );
}
