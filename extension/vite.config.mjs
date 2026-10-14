import { resolve } from "node:path";
import { build, defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

const ENTRY_FILE_NAMES = {
  worker: "worker.js",
  sidepanel: "sidepanel.js",
  "saved-page-frame": "saved-page-frame.js",
};

export default defineConfig({
  define: { __SOROERU_CLOUD_API_URL__: JSON.stringify(process.env.VITE_SOROERU_CLOUD_API_URL ?? "") },
  plugins: [
    react(),
    tailwindcss(),
    {
      name: "classic-content-script",
      apply: "build",
      async closeBundle() {
        // executeScript injects a classic script, so it cannot load ESM shared chunks.
        await build({
          configFile: false,
          build: {
            outDir: resolve(process.cwd(), "dist/extension"),
            emptyOutDir: false,
            lib: {
              entry: resolve(process.cwd(), "extension/content-script.ts"),
              name: "SoroeruContent",
              formats: ["iife"],
              fileName: () => "content-script.js",
            },
          },
        });
      },
    },
  ],
  build: {
    outDir: resolve(process.cwd(), "dist/extension"),
    emptyOutDir: true,
    rollupOptions: {
      input: {
        worker: resolve(process.cwd(), "extension/worker.ts"),
        sidepanel: resolve(process.cwd(), "extension/sidepanel.tsx"),
        "saved-page-frame": resolve(process.cwd(), "extension/saved-page-frame.ts"),
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
          asset.names.some((name) => name.endsWith(".css"))
            ? "sidepanel.css"
            : "assets/[name]-[hash][extname]",
      },
    },
  },
});
