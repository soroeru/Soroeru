import { fileURLToPath } from "node:url";
import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

const at = (p: string): string => fileURLToPath(new URL(p, import.meta.url));

// Strict CSP for the production (file://) renderer: same-origin only, no remote
// origins, no eval. `style-src 'unsafe-inline'` is required for injected CSS.
// Applied only to the built HTML so the Vite dev server's inline Fast Refresh
// preamble keeps working under `npm run dev`.
const PRODUCTION_CSP =
  "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'";

function productionCspPlugin(): Plugin {
  return {
    name: "soroeru-production-csp",
    apply: "build",
    transformIndexHtml(html) {
      return html.replace(
        "</title>",
        `</title>\n    <meta http-equiv="Content-Security-Policy" content="${PRODUCTION_CSP}" />`,
      );
    },
  };
}

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
    plugins: [react(), tailwindcss(), productionCspPlugin()],
    build: {
      outDir: at("dist/renderer"),
      emptyOutDir: true,
    },
    server: { port: 5173, strictPort: true },
  };
});
