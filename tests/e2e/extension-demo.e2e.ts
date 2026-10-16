import { expect, test } from "@playwright/test";
import { openDemo, payloadHash, type CapturedRequest, type DemoBrowser } from "./helpers/extension-demo.js";

const personal = /fake@example\.com|090-0000-0000|架空花子/;
const secrets = /fake-secret-password|987|123456/;

function requests(browser: DemoBrowser, operation: CapturedRequest["operation"]): CapturedRequest[] {
  return browser.requests.filter((request) => request.operation === operation);
}

test("Tier 1 reads a shared schema locally", async () => {
  const browser = await openDemo("tier1");
  try {
    await expect(browser.panel.getByRole("checkbox", { name: /クラウドのフォーム知識と Gemini を使う/ })).not.toBeChecked();
    await browser.panel.getByRole("checkbox", { name: /クラウドのフォーム知識と Gemini を使う/ }).click();
    await expect(browser.panel.getByRole("checkbox", { name: /クラウドのフォーム知識と Gemini を使う/ })).toBeChecked();
    await browser.run();
    await expect(
      browser.panel
        .getByText(/Demo tier1/)
        .locator("..")
        .getByText(/開示/),
    ).toBeVisible();
    const fingerprint = await browser.probeFingerprint();
    const observed = await browser.inspect();
    expect(
      requests(browser, "resolve"),
      JSON.stringify({ observed, fingerprint, diagnostics: browser.diagnostics }),
    ).toHaveLength(1);
    expect(requests(browser, "mapStructure")).toHaveLength(0);
    expect(requests(browser, "tier3Ticket")).toHaveLength(0);
    expect(JSON.stringify(browser.requests)).not.toMatch(personal);
  } finally {
    await browser.close();
  }
});

test("Tier 2 sends structure only and reads mapped values locally", async () => {
  const browser = await openDemo("tier2");
  try {
    await browser.panel.getByRole("checkbox", { name: /クラウドのフォーム知識と Gemini を使う/ }).click();
    await expect(browser.panel.getByRole("checkbox", { name: /クラウドのフォーム知識と Gemini を使う/ })).toBeChecked();
    await browser.run();
    await expect(
      browser.panel
        .getByText(/Demo tier2/)
        .locator("..")
        .getByText(/開示/),
    ).toBeVisible();
    expect(requests(browser, "resolve")).toHaveLength(1);
    expect(requests(browser, "mapStructure")).toHaveLength(1);
    expect(requests(browser, "tier3Ticket")).toHaveLength(0);
    expect(JSON.stringify(browser.requests)).not.toMatch(personal);
  } finally {
    await browser.close();
  }
});

test("Tier 3 decline keeps Tier 2 observations and sends no PII request", async () => {
  const browser = await openDemo("tier3");
  try {
    await browser.panel.getByRole("checkbox", { name: /クラウドのフォーム知識と Gemini を使う/ }).click();
    await expect(browser.panel.getByRole("checkbox", { name: /クラウドのフォーム知識と Gemini を使う/ })).toBeChecked();
    await browser.run();
    const gate = browser.panel.getByRole("dialog", { name: /Gemini/ });
    await expect(gate).toBeVisible();
    expect(requests(browser, "tier3Ticket")).toHaveLength(0);
    expect(requests(browser, "readWithConsent")).toHaveLength(0);
    await gate.getByRole("button", { name: "送信しない" }).click();
    await expect(gate).toBeHidden();
    await expect(
      browser.panel
        .getByText(/Demo tier3/)
        .locator("..")
        .getByText(/開示/),
    ).toBeVisible();
    expect(requests(browser, "tier3Ticket")).toHaveLength(0);
    expect(requests(browser, "readWithConsent")).toHaveLength(0);
    expect(JSON.stringify(browser.requests)).not.toMatch(personal);
  } finally {
    await browser.close();
  }
});

test("Tier 3 approval binds a masked, bounded payload to one ticket", async () => {
  const browser = await openDemo("tier3");
  try {
    await browser.panel.getByRole("checkbox", { name: /クラウドのフォーム知識と Gemini を使う/ }).click();
    await expect(browser.panel.getByRole("checkbox", { name: /クラウドのフォーム知識と Gemini を使う/ })).toBeChecked();
    await browser.run();
    const gate = browser.panel.getByRole("dialog", { name: /Gemini/ });
    await expect(gate).toBeVisible();
    expect(requests(browser, "tier3Ticket")).toHaveLength(0);
    await gate.getByRole("button", { name: "この1回だけ送信する" }).click();
    await expect(
      browser.panel
        .getByText(/Demo tier3/)
        .locator("..")
        .getByText(/開示/),
    ).toBeVisible();
    const ticket = requests(browser, "tier3Ticket");
    const read = requests(browser, "readWithConsent");
    expect(ticket).toHaveLength(1);
    expect(read).toHaveLength(1);
    expect(browser.requests.indexOf(ticket[0]!)).toBeLessThan(browser.requests.indexOf(read[0]!));
    const readBody = read[0]!.body as {
      ticket: string;
      consentId: string;
      site: string;
      requestedKeys: string[];
      items: { id: string; label?: string; text: string }[];
    };
    const ticketBody = ticket[0]!.body as { consentId: string; site: string; payloadSha256: string };
    expect(readBody.ticket).toBe("fake.ticket");
    expect(ticketBody.consentId).toBe(readBody.consentId);
    expect(ticketBody.site).toBe(readBody.site);
    expect(ticketBody.payloadSha256).toBe(
      payloadHash({
        consentId: readBody.consentId,
        site: readBody.site,
        requestedKeys: readBody.requestedKeys,
        items: readBody.items,
      }),
    );
    expect(new TextEncoder().encode(JSON.stringify(readBody)).byteLength).toBeLessThanOrEqual(16_384);
    expect(JSON.stringify(readBody)).toContain("[SECRET]");
    expect(JSON.stringify(readBody)).not.toMatch(secrets);
    expect(JSON.stringify(requests(browser, "mapStructure"))).not.toMatch(personal);
    expect(JSON.stringify(requests(browser, "feedback"))).not.toMatch(personal);
    expect(JSON.stringify(requests(browser, "outcome"))).not.toMatch(personal);
  } finally {
    await browser.close();
  }
});

test("Tier 3 run consent shows its limits and the next collection asks again", async () => {
  const browser = await openDemo("tier3");
  try {
    await browser.panel.getByRole("checkbox", { name: /クラウドのフォーム知識と Gemini を使う/ }).click();
    await expect(browser.panel.getByRole("checkbox", { name: /改善用の動作データを送る/ })).not.toBeChecked();
    await browser.run();
    const gate = browser.panel.getByRole("dialog", { name: /Gemini/ });
    await expect(gate).toBeVisible();
    await expect(gate.getByText(/最大 20 件/)).toBeVisible();
    await expect(gate.getByText(/15 分/)).toBeVisible();
    await expect(gate.getByText("Soroeru Cloud（Google Cloud）経由の Gemini")).toBeVisible();
    await gate.getByRole("button", { name: "この収集だけ許可する" }).click();
    await expect(
      browser.panel
        .getByText(/Demo tier3/)
        .locator("..")
        .getByText(/開示/),
    ).toBeVisible();
    expect(requests(browser, "tier3Ticket")).toHaveLength(1);
    expect(requests(browser, "readWithConsent")).toHaveLength(1);
    await browser.run();
    await expect(browser.panel.getByRole("dialog", { name: /Gemini/ })).toBeVisible();
    expect(requests(browser, "tier3Ticket")).toHaveLength(1);
    await browser.panel.getByRole("button", { name: "送信しない" }).click();
    expect(requests(browser, "readWithConsent")).toHaveLength(1);
  } finally {
    await browser.close();
  }
});

test("wall fixture stops at same-tab handoff", async () => {
  const browser = await openDemo("wall");
  try {
    await browser.panel.getByRole("checkbox", { name: /クラウドのフォーム知識と Gemini を使う/ }).click();
    await expect(browser.panel.getByRole("checkbox", { name: /クラウドのフォーム知識と Gemini を使う/ })).toBeChecked();
    await browser.run();
    await expect(browser.panel.getByRole("alert").filter({ hasText: "確認が必要です" })).toBeVisible();
    expect(browser.fixture.url()).toBe("https://demo.example/wall");
    expect(requests(browser, "tier3Ticket")).toHaveLength(0);
    expect(requests(browser, "readWithConsent")).toHaveLength(0);
    await browser.panel.getByRole("button", { name: "中止" }).click();
  } finally {
    await browser.close();
  }
});

test("identity-free local collection and canonical editing work with Cloud off", async () => {
  const browser = await openDemo("tier1");
  try {
    await browser.panel.getByLabel("正典の項目").selectOption("email");
    await browser.panel.getByLabel("正典の値").fill("canonical@example.test");
    await browser.panel.getByRole("button", { name: "保存", exact: true }).click();
    await expect(browser.panel.getByText("保存しました", { exact: true })).toBeVisible();
    await expect(browser.panel.getByText("ユーザー入力・未検証", { exact: true })).toBeVisible();
    await browser.run();
    await expect(browser.panel.getByText(/collected: 開示/)).toBeVisible();
    expect(browser.requests).toHaveLength(0);
    expect((await browser.inspect()).disclosures).toBeGreaterThan(0);
  } finally { await browser.close(); }
});

test("L1 starts with no selections and limits collection to explicitly selected attributes", async () => {
  const browser = await openDemo("tier1");
  try {
    await browser.panel.getByText(/収集の自動実行範囲/).click();
    const scope = browser.panel.locator("details").filter({ hasText: "収集の自動実行範囲" });
    await expect(scope.getByRole("checkbox", { name: "メールアドレス", exact: true })).not.toBeChecked();
    await scope.getByRole("checkbox", { name: "Demo tier1", exact: true }).check();
    await scope.getByRole("checkbox", { name: "メールアドレス", exact: true }).check();
    await scope.getByRole("button", { name: "この範囲で L1 を有効にする" }).click();
    await expect(scope.locator("summary")).toContainText("L1");
    await browser.run();
    await expect(browser.panel.getByText(/collected: 開示 1/)).toBeVisible();
    expect(browser.requests).toHaveLength(0);
    await scope.getByRole("button", { name: "L1 を停止する" }).click();
    await expect(scope.locator("summary")).toContainText("L0");
    expect((await browser.inspect()).disclosures).toBe(1);
  } finally { await browser.close(); }
});

test("one collection resolves two regions with one run gate and separate tickets", async () => {
  const browser = await openDemo("tier3-regions");
  try {
    await browser.panel.getByRole("checkbox", { name: /クラウドのフォーム知識と Gemini を使う/ }).click();
    await browser.run();
    const gate = browser.panel.getByRole("dialog", { name: /Gemini/ });
    await expect(gate).toBeVisible();
    await gate.getByRole("button", { name: "この収集だけ許可する" }).click();
    await expect(browser.panel.getByText(/Demo tier3-regions/).locator("..").getByText(/開示/)).toBeVisible();
    await expect(gate).toBeHidden();
    const reads = requests(browser, "readWithConsent");
    const tickets = requests(browser, "tier3Ticket");
    expect(reads).toHaveLength(2);
    expect(tickets).toHaveLength(2);
    const first = reads[0]!.body as CloudRead;
    const second = reads[1]!.body as CloudRead;
    expect(first.items.some(item => item.text === "090-0000-0000")).toBe(true);
    expect(first.items.some(item => item.text === "架空花子")).toBe(false);
    expect(second.items.some(item => item.text === "架空花子")).toBe(true);
    expect(second.items.some(item => item.text === "090-0000-0000")).toBe(false);
    expect(second.consentId).not.toBe(first.consentId);
    expect(JSON.stringify(reads)).not.toMatch(secrets);
    expect((await browser.inspect()).disclosures).toBe(3);
  } finally {
    await browser.close();
  }
});

type CloudRead = { consentId: string; requestedKeys: string[]; items: { text: string }[] };

test("navigation during a gate requires fresh consent for the new page kind", async () => {
  const browser = await openDemo("tier3");
  try {
    await browser.panel.getByRole("checkbox", { name: /クラウドのフォーム知識と Gemini を使う/ }).click();
    await browser.run();
    const gate = browser.panel.getByRole("dialog", { name: /Gemini/ });
    await expect(gate).toBeVisible();
    // Keep the identical element tree but navigate within the leased site and change its purpose.
    await browser.fixture.evaluate(() => { history.pushState({}, "", "/tier3?contact"); document.querySelector("h1")!.textContent = "連絡先"; document.querySelector("#phone")!.id = "contact"; });
    await gate.getByRole("button", { name: "この収集だけ許可する" }).click();
    await expect(gate.getByText("連絡先", { exact: true })).toBeVisible();
    expect(requests(browser, "readWithConsent")).toHaveLength(0);
    expect(requests(browser, "tier3Ticket")).toHaveLength(0);
    await gate.getByRole("button", { name: "この収集だけ許可する" }).click();
    await expect(browser.panel.getByText(/Demo tier3/).locator("..").getByText(/開示/)).toBeVisible();
    expect(requests(browser, "readWithConsent")).toHaveLength(1);
  } finally {
    await browser.close();
  }
});
