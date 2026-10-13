import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/e2e",
  testMatch: "extension-demo.e2e.ts",
  workers: 1,
  retries: 0,
  timeout: 300_000,
  globalSetup: "./tests/e2e/helpers/extension-demo-setup.ts",
  reporter: "list",
  use: { trace: "off", screenshot: "off", video: "off" },
});
