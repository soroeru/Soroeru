import { openDemo, type DemoPage } from "./helpers/extension-demo.js";

const args = process.argv.slice(2);
const pages: DemoPage[] = ["tier1", "tier2", "tier3", "tier3-regions", "wall"];
if (args.includes("--help")) {
  console.log("Usage: npm run uat:extension-demo -- [--page tier1|tier2|tier3|tier3-regions|wall] [--empty]");
} else {
  let page: DemoPage = "tier3";
  let seed = true;
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === "--empty") seed = false;
    else if (arg === "--page" && pages.includes(args[index + 1] as DemoPage)) {
      page = args[++index] as DemoPage;
    } else throw new Error("Invalid arguments. Use --help for usage.");
  }
  // Install handlers before startup so Ctrl+C during initialization also cleans up.
  let stop!: () => void;
  const stopped = new Promise<void>((resolve) => {
    stop = resolve;
  });
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  let demo: Awaited<ReturnType<typeof openDemo>> | undefined;
  try {
    demo = await openDemo(page, {
      headless: false,
      seed,
      onRequest: (operation, count) => console.log(`${operation}: ${count}`),
    });
    demo.context.once("close", stop);
    const launcherUrl = new URL("demo-launcher.html", demo.panel.url()).href;
    await demo.panel.close();
    const launcher = await demo.context.newPage();
    await launcher.goto(launcherUrl);
    await Promise.all([
      launcher.waitForEvent("close", { timeout: 30_000 }),
      launcher.getByRole("button", { name: "Open Soroeru Side Panel" }).click(),
    ]);
    await demo.fixture.bringToFront();
    console.log(`Demo ${page} ready (${seed ? "seeded" : "empty"}). Close Chromium or press Ctrl+C to exit.`);
    console.log(
      "Use the Chromium Side Panel. For the seeded vault, unlock with fake-demo-passphrase-565. Cloud assistance defaults off; enable it in settings. Request bodies are available in DevTools.",
    );
    await stopped;
  } finally {
    try {
      await demo?.close();
    } finally {
      process.removeListener("SIGINT", stop);
      process.removeListener("SIGTERM", stop);
    }
  }
}
