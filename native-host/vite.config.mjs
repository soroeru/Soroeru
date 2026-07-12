import { resolve } from "node:path";
import { defineConfig } from "vite";

// Bundle the native messaging host into one self-contained CommonJS file.
// registerNativeHost copies a single file into app-support and Chrome runs it
// from there, so the installed host cannot rely on sibling compiled modules.
export default defineConfig({
  build: {
    outDir: resolve(process.cwd(), "dist/native-host"),
    emptyOutDir: true,
    ssr: true,
    rollupOptions: {
      input: { host: resolve(process.cwd(), "native-host/host.ts") },
      output: {
        // host.ts's own "#!/usr/bin/env node" shebang is preserved in the bundle.
        entryFileNames: "host.cjs",
        format: "cjs",
      },
    },
  },
  ssr: { noExternal: true },
});
