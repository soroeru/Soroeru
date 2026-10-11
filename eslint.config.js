// ESLint flat config (RFC-002 §2.7). Introduced with the first React/Electron
// sources (issue #158) and scoped to those new directories; broadening lint to
// the legacy `src/agent`, `src/app`, `run`, etc. is deliberate follow-up so this
// PR does not bury reviewers in pre-existing findings.

import js from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";
import reactHooks from "eslint-plugin-react-hooks";
import reactRefresh from "eslint-plugin-react-refresh";

export default tseslint.config(
  {
    ignores: [
      "**/dist/**",
      "**/node_modules/**",
      "**/out/**",
      "**/release/**",
      "**/state/**",
      "**/.worktrees/**",
    ],
  },
  {
    files: [
      "electron/**/*.ts",
      "cloud/src/**/*.ts",
      "src/shared/cloud-contract.ts",
      "extension/cloud-client.ts",
    ],
    extends: [js.configs.recommended, ...tseslint.configs.recommended],
    languageOptions: {
      globals: { ...globals.node },
      parserOptions: { ecmaVersion: 2022, sourceType: "module" },
    },
  },
  {
    files: ["src/renderer/**/*.{ts,tsx}", "extension/**/*.tsx"],
    extends: [js.configs.recommended, ...tseslint.configs.recommended],
    languageOptions: {
      globals: { ...globals.browser },
      parserOptions: { ecmaVersion: 2022, sourceType: "module" },
    },
    plugins: {
      "react-hooks": reactHooks,
      "react-refresh": reactRefresh,
    },
    rules: {
      ...reactHooks.configs.recommended.rules,
      "react-refresh/only-export-components": ["warn", { allowConstantExport: true }],
    },
  },
);
