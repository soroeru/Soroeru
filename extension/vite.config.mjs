import { resolve } from "node:path";
import { defineConfig } from "vite";

export default defineConfig({
  build: {
    outDir: resolve(process.cwd(), "dist/extension"),
    emptyOutDir: true,
    rollupOptions: {
      input: {
        worker: resolve(process.cwd(), "extension/worker.ts"),
        contentScript: resolve(process.cwd(), "extension/content-script.ts"),
      },
      output: {
        entryFileNames: (chunk) => (chunk.name === "contentScript" ? "content-script.js" : "worker.js"),
      },
    },
  },
});
