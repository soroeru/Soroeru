import { resolve } from "node:path";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  build: {
    outDir: resolve(process.cwd(), "dist/extension"),
    emptyOutDir: true,
    rollupOptions: {
      input: {
        worker: resolve(process.cwd(), "extension/worker.ts"),
        contentScript: resolve(process.cwd(), "extension/content-script.ts"),
        sidepanel: resolve(process.cwd(), "extension/sidepanel.tsx"),
      },
      output: {
        entryFileNames: (chunk) =>
          chunk.name === "contentScript" ? "content-script.js" : chunk.name === "sidepanel" ? "sidepanel.js" : "worker.js",
        // The Side Panel's stylesheet is linked by name from extension/sidepanel.html.
        assetFileNames: (asset) =>
          asset.names.some((name) => name.endsWith(".css")) ? "sidepanel.css" : "assets/[name]-[hash][extname]",
      },
    },
  },
});
