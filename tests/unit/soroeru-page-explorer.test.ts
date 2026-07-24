import assert from "node:assert/strict";
import { test } from "node:test";
import type { DecisionKind, DecisionRequest, RuleEvaluator, RuleResult } from "../../src/automation/decision-engine.js";
import { DecisionEngine } from "../../src/automation/decision-engine.js";
import type { ExplorationEvent } from "../../src/automation/page-explorer.js";
import { PageExplorer } from "../../src/automation/page-explorer.js";
import type { PageDriver } from "../../src/automation/page-driver.js";
import { RuleEngine } from "../../src/automation/rule-engine.js";
import { WallDetectionService } from "../../src/automation/wall-detection.js";
import type { PageLink, PageSnapshot } from "../../src/types.js";

const SITE = { id: "site-1", domain: "example.com", displayName: "Example" };

function snapshot(url: string, partial: Partial<PageSnapshot> = {}): PageSnapshot {
  return {
    url,
    title: "",
    fields: [],
    buttons: [],
    links: [],
    visibleText: "",
    iframeSrcs: [],
    wallMarkers: [],
    ...partial,
  };
}

function links(...items: Array<[string, string]>): PageLink[] {
  return items.map(([text, href]) => ({ text, href }));
}

/** Scripted fake: serves per-URL snapshots and records every navigation. */
class FakePageDriver implements PageDriver {
  readonly gotoLog: string[] = [];
  private url = "";

  constructor(private readonly pages: Map<string, PageSnapshot>) {}

  async goto(url: string): Promise<void> {
    this.gotoLog.push(url);
    this.url = url;
  }
  /** Simulate the human navigating in the headed session (no machine goto). */
  simulateUserNavigation(url: string): void {
    this.url = url;
  }
  currentUrl(): string {
    return this.url;
  }
  async snapshot(): Promise<PageSnapshot> {
    return this.pages.get(this.url) ?? snapshot(this.url);
  }
  async readValues(): Promise<Record<string, string>> {
    return {};
  }
  async fillField(): Promise<void> {}
  async click(): Promise<void> {}
  async waitForReady(): Promise<void> {}
}

function makeExplorer(ruleEngine = new RuleEngine()): PageExplorer {
  return new PageExplorer(new DecisionEngine(ruleEngine), new WallDetectionService());
}

async function collect(events: AsyncGenerator<ExplorationEvent>): Promise<ExplorationEvent[]> {
  const collected: ExplorationEvent[] = [];
  for await (const event of events) collected.push(event);
  return collected;
}

test("explores linked profile pages in priority order and completes when URLs run out", async () => {
  const driver = new FakePageDriver(
    new Map([
      [
        "https://example.com/mypage",
        snapshot("https://example.com/mypage", {
          links: links(
            ["お届け先住所", "/address"],
            ["会員情報", "/profile"],
            ["プロフィール", "https://evil.example/profile"],
            ["ヘルプ", "/help"],
          ),
        }),
      ],
      [
        "https://example.com/profile",
        snapshot("https://example.com/profile", {
          // Fragment + trailing-slash variants of visited/queued pages must not
          // be re-queued (visitedUrls holds normalized URLs).
          links: links(["マイページ", "/mypage#top"], ["登録情報", "/profile/"], ["配送先", "/address"]),
        }),
      ],
      ["https://example.com/address", snapshot("https://example.com/address")],
    ]),
  );

  const events = await collect(makeExplorer().explore(driver, "https://example.com/mypage", SITE));

  assert.deepEqual(driver.gotoLog, [
    "https://example.com/mypage",
    "https://example.com/profile",
    "https://example.com/address",
  ]);
  assert.deepEqual(
    events.map((e) => e.kind),
    [
      "navigating",
      "page-snapshot",
      "navigating",
      "page-snapshot",
      "navigating",
      "page-snapshot",
      "exploration-complete",
    ],
  );
  const complete = events.at(-1);
  assert.equal(complete?.kind, "exploration-complete");
  if (complete?.kind !== "exploration-complete") assert.fail("expected exploration-complete");
  assert.equal(complete.reason, "no-more-urls");
  const snapshots = events.filter((e) => e.kind === "page-snapshot");
  assert.deepEqual(
    snapshots.map((e) => e.kind === "page-snapshot" && e.snapshot.url),
    ["https://example.com/mypage", "https://example.com/profile", "https://example.com/address"],
  );
});

test("defers a walled URL, hands off, and resume() observes the current page without re-goto (Issue #420)", async () => {
  const pages = new Map([
    [
      "https://example.com/mypage",
      snapshot("https://example.com/mypage", { links: links(["会員情報", "/profile"]) }),
    ],
    ["https://example.com/profile", snapshot("https://example.com/profile", { wallMarkers: ["g-recaptcha"] })],
  ]);
  const driver = new FakePageDriver(pages);
  const explorer = makeExplorer();

  const firstRun = await collect(explorer.explore(driver, "https://example.com/mypage", SITE));

  const wallEvent = firstRun.at(-1);
  assert.equal(wallEvent?.kind, "wall-detected");
  if (wallEvent?.kind !== "wall-detected") assert.fail("expected wall-detected");
  assert.equal(wallEvent.url, "https://example.com/profile");
  assert.equal(wallEvent.wall.kind, "captcha");
  assert.deepEqual(wallEvent.handoff, {
    reason: "captcha",
    evidence: wallEvent.wall.evidence,
    resumable: true,
  });
  // Exploration paused on the wall: no page-snapshot for the walled page, no completion.
  assert.equal(firstRun.some((e) => e.kind === "exploration-complete"), false);
  assert.deepEqual(driver.gotoLog, ["https://example.com/mypage", "https://example.com/profile"]);

  // Resuming while the wall is still up re-handoffs from the *current* page
  // without a machine re-navigation (Issue #420 — re-goto would re-trigger
  // the site's risk gate).
  const stillWalled = await collect(explorer.resume());
  assert.deepEqual(
    stillWalled.map((e) => e.kind),
    ["wall-detected"],
  );
  assert.equal(stillWalled[0]?.kind === "wall-detected" && stillWalled[0].url, "https://example.com/profile");
  assert.deepEqual(driver.gotoLog, ["https://example.com/mypage", "https://example.com/profile"]);

  // The human resolved the wall on the same page; the page now renders normally.
  pages.set("https://example.com/profile", snapshot("https://example.com/profile"));

  const resumed = await collect(explorer.resume());

  // No additional goto: resume collected the visible page and completed.
  assert.deepEqual(driver.gotoLog, ["https://example.com/mypage", "https://example.com/profile"]);
  assert.deepEqual(
    resumed.map((e) => e.kind),
    ["page-snapshot", "exploration-complete"],
  );
  assert.equal(resumed[0]?.kind === "page-snapshot" && resumed[0].url, "https://example.com/profile");
});

test("resume() collects the page the user opened after the wall, not the walled URL (Issue #420)", async () => {
  const pages = new Map([
    [
      "https://example.com/mypage",
      snapshot("https://example.com/mypage", {
        links: links(["会員情報", "/profile"], ["お支払い", "/payment"]),
      }),
    ],
    ["https://example.com/profile", snapshot("https://example.com/profile", { wallMarkers: ["g-recaptcha"] })],
    [
      "https://example.com/settings",
      snapshot("https://example.com/settings", {
        links: links(["配送先", "/address"]),
      }),
    ],
    ["https://example.com/address", snapshot("https://example.com/address")],
    ["https://example.com/payment", snapshot("https://example.com/payment")],
  ]);
  const driver = new FakePageDriver(pages);
  const explorer = makeExplorer();

  const firstRun = await collect(explorer.explore(driver, "https://example.com/mypage", SITE));
  assert.equal(firstRun.at(-1)?.kind, "wall-detected");
  // After mypage, RuleEngine prioritizes profile over payment; wall on profile
  // paused before payment was visited. pending still has payment.
  assert.ok(driver.gotoLog.includes("https://example.com/profile"));
  assert.equal(driver.gotoLog.includes("https://example.com/payment"), false);

  // Human cleared the wall by manually opening the account settings page
  // (not re-entering the walled /profile URL).
  driver.simulateUserNavigation("https://example.com/settings");

  const resumed = await collect(explorer.resume());

  // Must not re-goto the walled profile URL; must snapshot settings and may
  // continue remaining pending URLs (payment, address from settings).
  assert.equal(driver.gotoLog.filter((u) => u === "https://example.com/profile").length, 1);
  assert.equal(
    resumed.some((e) => e.kind === "page-snapshot" && e.url === "https://example.com/settings"),
    true,
  );
  assert.equal(
    resumed.some((e) => e.kind === "page-snapshot" && e.url === "https://example.com/profile"),
    false,
  );
  assert.equal(resumed.at(-1)?.kind, "exploration-complete");
});

test("resume() never machine-goto's a walled URL even when later links rediscover it (Issue #420)", async () => {
  const pages = new Map([
    [
      "https://example.com/mypage",
      snapshot("https://example.com/mypage", { links: links(["会員情報", "/profile"]) }),
    ],
    ["https://example.com/profile", snapshot("https://example.com/profile", { wallMarkers: ["g-recaptcha"] })],
    [
      "https://example.com/settings",
      snapshot("https://example.com/settings", {
        // Rediscover the formerly walled profile URL — machine must not re-goto it.
        links: links(["会員情報", "/profile"], ["配送先", "/address"]),
      }),
    ],
    ["https://example.com/address", snapshot("https://example.com/address")],
  ]);
  const driver = new FakePageDriver(pages);
  const explorer = makeExplorer();

  await collect(explorer.explore(driver, "https://example.com/mypage", SITE));
  driver.simulateUserNavigation("https://example.com/settings");

  const resumed = await collect(explorer.resume());

  assert.equal(driver.gotoLog.filter((u) => u === "https://example.com/profile").length, 1);
  assert.equal(
    resumed.some((e) => e.kind === "page-snapshot" && e.url === "https://example.com/settings"),
    true,
  );
  assert.equal(
    resumed.some((e) => e.kind === "page-snapshot" && e.url === "https://example.com/address"),
    true,
  );
  assert.equal(
    resumed.some((e) => e.kind === "navigating" && e.url === "https://example.com/profile"),
    false,
  );
  assert.equal(resumed.at(-1)?.kind, "exploration-complete");
});

test("resume() skips an off-site current page and does not re-queue the walled URL (Issue #420)", async () => {
  const pages = new Map([
    [
      "https://example.com/mypage",
      snapshot("https://example.com/mypage", { links: links(["会員情報", "/profile"], ["配送先", "/address"]) }),
    ],
    ["https://example.com/profile", snapshot("https://example.com/profile", { wallMarkers: ["g-recaptcha"] })],
    ["https://example.com/address", snapshot("https://example.com/address")],
  ]);
  const driver = new FakePageDriver(pages);
  const explorer = makeExplorer();

  await collect(explorer.explore(driver, "https://example.com/mypage", SITE));
  driver.simulateUserNavigation("https://evil.example/elsewhere");

  const resumed = await collect(explorer.resume());

  // Off-site page is not collected; previously walled profile is not re-goto'd;
  // remaining pending address (if still queued) may be visited.
  assert.equal(
    resumed.some((e) => e.kind === "page-snapshot" && e.url === "https://evil.example/elsewhere"),
    false,
  );
  assert.equal(driver.gotoLog.filter((u) => u === "https://example.com/profile").length, 1);
  assert.equal(resumed.at(-1)?.kind, "exploration-complete");
});

test("ends exploration when shouldContinue says stop (page cap reached)", async () => {
  const driver = new FakePageDriver(
    new Map([
      [
        "https://example.com/mypage",
        snapshot("https://example.com/mypage", { links: links(["会員情報", "/profile"]) }),
      ],
    ]),
  );

  const events = await collect(
    makeExplorer(new RuleEngine({ maxPagesPerSite: 1 })).explore(driver, "https://example.com/mypage", SITE),
  );

  // The profile link was queued but never visited: the cap ended the loop first.
  assert.deepEqual(driver.gotoLog, ["https://example.com/mypage"]);
  const complete = events.at(-1);
  assert.equal(complete?.kind, "exploration-complete");
  if (complete?.kind !== "exploration-complete") assert.fail("expected exploration-complete");
  assert.equal(complete.reason, "decision-engine");
});

test("never navigates off-site even when the decision layer suggests an external link", async () => {
  // A fake evaluator standing in for a misbehaving AI suggestion: confidently
  // returns an off-site link, which the explorer itself must refuse to queue.
  const offSiteEvaluator: RuleEvaluator = {
    evaluate<K extends DecisionKind>(request: DecisionRequest & { kind: K }): RuleResult<K> {
      const result: RuleResult =
        request.kind === "find-profile-links"
          ? { confident: true, result: { links: [{ href: "https://evil.example/profile", text: "会員情報" }] } }
          : { confident: false, result: { continue: true } };
      return result as RuleResult<K>;
    },
  };
  const driver = new FakePageDriver(new Map());
  const explorer = new PageExplorer(new DecisionEngine(offSiteEvaluator), new WallDetectionService());

  const events = await collect(explorer.explore(driver, "https://example.com/mypage", SITE));

  assert.deepEqual(driver.gotoLog, ["https://example.com/mypage"]);
  const complete = events.at(-1);
  assert.equal(complete?.kind, "exploration-complete");
  if (complete?.kind !== "exploration-complete") assert.fail("expected exploration-complete");
  assert.equal(complete.reason, "no-more-urls");
});

test("resume() without a paused exploration throws, including after completion", async () => {
  const explorer = makeExplorer();
  await assert.rejects(explorer.resume().next(), /no exploration state to resume/);

  const driver = new FakePageDriver(new Map());
  await collect(explorer.explore(driver, "https://example.com/mypage", SITE));
  // Completion clears the resume slot; only a wall hand-off keeps it.
  await assert.rejects(explorer.resume().next(), /no exploration state to resume/);
});
