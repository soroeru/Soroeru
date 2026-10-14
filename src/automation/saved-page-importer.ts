import { chromium } from "playwright";
import { snapshotPage } from "../agent/scan.js";
import {
  importSavedPageWith,
  readDisplayValues,
  readFieldValues,
  type SavedPageImportInput,
  type SavedPageImportResult,
  type SavedPageRenderer,
} from "./saved-page-core.js";

export {
  MAX_SAVED_PAGE_BYTES,
  type SavedPageImportInput,
  type SavedPageImportResult,
} from "./saved-page-core.js";

/**
 * Electron renderer for the saved-page import: headless Chromium with
 * JavaScript disabled and every non-inline request aborted, so the saved page
 * can neither run scripts nor egress.
 */
export const playwrightSavedPageRenderer: SavedPageRenderer = async (htmlText) => {
  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext({ javaScriptEnabled: false });
    await context.route("**/*", (route) => {
      const url = route.request().url();
      if (url.startsWith("data:") || url.startsWith("about:") || url.startsWith("blob:")) {
        void route.continue();
        return;
      }
      void route.abort();
    });
    const page = await context.newPage();
    await page.setContent(htmlText, { waitUntil: "domcontentloaded" });
    await page.waitForLoadState("networkidle", { timeout: 3000 }).catch(() => {});
    const snapshot = await snapshotPage(page);
    const values = await page.evaluate(readFieldValues);
    const displayValues = await page.evaluate(readDisplayValues);
    return { snapshot, values, displayValues };
  } finally {
    await browser.close().catch(() => {});
  }
};

export async function importSavedPage(input: SavedPageImportInput): Promise<SavedPageImportResult> {
  return importSavedPageWith(playwrightSavedPageRenderer, input);
}
