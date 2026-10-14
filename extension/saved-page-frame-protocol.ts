// Shared message names and the saved-page sanitizer for the Side Panel's
// saved-page scan frame (Issue #569). DOM-API-only so unit tests can drive it
// with any `DOMParser`-compatible parser.

export const SAVED_PAGE_FRAME_MESSAGES = {
  ready: "soroeru:saved-page-frame:ready",
  render: "soroeru:saved-page-frame:render",
  rendered: "soroeru:saved-page-frame:rendered",
  failed: "soroeru:saved-page-frame:failed",
} as const;

/**
 * Elements removed before the saved page is adopted into the frame. Scripts never run
 * (CSP and parser flags already prevent it), but stripping them, nested browsing
 * contexts, plugins, `<base>`, `<link>`, and `http-equiv` metas (refresh, CSP
 * overrides) keeps the document inert even if a browser behavior changes.
 */
export const INERT_STRIP_SELECTOR =
  "script, iframe, frame, frameset, object, embed, base, link, meta[http-equiv]";

/** Parse saved HTML into a document with every active or loading element removed. */
export function inertSavedPageDocument(html: string, parser: Pick<DOMParser, "parseFromString">): Document {
  const parsed = parser.parseFromString(html, "text/html");
  for (const el of Array.from(parsed.querySelectorAll(INERT_STRIP_SELECTOR))) el.remove();
  return parsed;
}
