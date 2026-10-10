import { resolve } from "node:path";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

const ENTRY_FILE_NAMES = {
  worker: "worker.js",
  contentScript: "content-script.js",
  sidepanel: "sidepanel.js",
};

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
        // Fixed names referenced by manifest.json / sidepanel.html; an unmapped entry fails the build.
        entryFileNames: (chunk) => {
          const name = ENTRY_FILE_NAMES[chunk.name];
          if (!name) throw new Error(`no output file name for extension entry "${chunk.name}"`);
          return name;
        },
        // The Side Panel's stylesheet is linked by name from extension/sidepanel.html.
        assetFileNames: (asset) =>
          asset.names.some((name) => name.endsWith(".css")) ? "sidepanel.css" : "assets/[name]-[hash][extname]",
      },
    },
  },
});
