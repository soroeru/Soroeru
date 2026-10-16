import { expect, test } from "@playwright/test";
import { openDemo } from "./helpers/extension-demo.js";

// Issue #569: a hand-off from the collection tab must not latch the ledger's busy state
// and leave the other screens disabled once the run has ended.
test("after a collection-tab hand-off ends, the ledger and other tabs are usable again", async () => {
  const browser = await openDemo("wall");
  try {
    const tab = (name: string) => browser.panel.getByRole("button", { name, exact: true });
    await tab("開示台帳").click();
    await expect(browser.panel.getByRole("button", { name: "選択したサイトを収集" })).toBeVisible();
    await tab("このタブで収集").click();

    await browser.run();
    await expect(browser.panel.getByRole("alert").filter({ hasText: "確認が必要です" })).toBeVisible();
    await expect(tab("開示台帳")).toBeDisabled();
    await browser.panel.getByRole("button", { name: "中止" }).click();

    await expect(tab("開示台帳")).toBeEnabled();
    await tab("開示台帳").click();
    await expect(browser.panel.getByRole("button", { name: "選択したサイトを収集" })).toBeVisible();
    await expect(tab("設定")).toBeEnabled();
    await tab("設定").click();
    await expect(browser.panel.getByRole("button", { name: "ログをダウンロード" })).toBeVisible();
  } finally {
    await browser.close();
  }
});
