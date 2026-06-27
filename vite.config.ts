import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

const at = (p: string): string => fileURLToPath(new URL(p, import.meta.url));

// One config, two outputs:
//   - default mode: the React renderer (untrusted UI surface) -> dist/renderer
//   - `--mode preload`: the sandboxed preload bundled to a self-contained
//     CommonJS file (sandbox: true requires a single CJS module) -> dist/preload
export default defineConfig(({ mode }) => {
  if (mode === "preload") {
    return {
      build: {
        outDir: at("dist/preload"),
        emptyOutDir: true,
        minify: false,
        lib: {
          entry: at("electron/preload.ts"),
          formats: ["cjs"] as const,
          fileName: () => "preload.cjs",
        },
        rollupOptions: { external: ["electron"] },
      },
    };
  }

  return {
    root: at("src/renderer"),
    // Relative base so the production build loads correctly from file://.
    base: "./",
    plugins: [react(), tailwindcss()],
    build: {
      outDir: at("dist/renderer"),
      emptyOutDir: true,
    },
    server: { port: 5173, strictPort: true },
  };
});
