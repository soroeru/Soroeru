import { join, resolve } from "node:path";
import { writeFile } from "node:fs/promises";
import { build } from "vite";

export default async function setup() {
  await build({
    configFile: false,
    logLevel: "silent",
    build: {
      outDir: resolve("dist/extension"),
      emptyOutDir: false,
      lib: {
        entry: resolve("tests/e2e/helpers/seed-extension-vault.ts"),
        name: "SeedExtensionVault",
        formats: ["iife"],
        fileName: () => "seed-vault.js",
      },
    },
  });
  await writeFile(
    join(resolve("dist/extension"), "seed-vault.html"),
    '<!doctype html><script src="seed-vault.js"></script>',
  );
}
