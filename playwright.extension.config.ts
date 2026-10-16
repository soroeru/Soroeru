import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/e2e",
  testMatch: ["extension-demo.e2e.ts", "sidepanel-shell.e2e.ts"],
  workers: 1,
  retries: 0,
  timeout: 300_000,
  reporter: "list",
  use: { trace: "off", screenshot: "off", video: "off" },
  expect: { timeout: 30_000 },
});
