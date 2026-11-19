import eslint from "@eslint/js";
import { defineConfig } from "eslint/config";
import solid from "eslint-plugin-solid/configs/typescript";
import globals from "globals";
import tseslint from "typescript-eslint";

export default defineConfig(
  {
    // deps/ and vendor/ are local checkouts of other repos; public/play/ and
    // dist/ are build output; data/ holds match files.
    ignores: ["deps/**", "vendor/**", "node_modules/**", "dist/**", "public/play/**", "data/**"],
  },
  eslint.configs.recommended,
  tseslint.configs.recommended,
  {
    // Server, scripts and tests run in Node.
    files: ["src/**/*.ts", "scripts/**/*.{ts,mjs}", "*.{js,mjs,ts}", "client/vite.config.ts"],
    languageOptions: { globals: { ...globals.node } },
  },
  {
    // The product client runs in the browser and is written in SolidJS.
    files: ["client/src/**/*.{ts,tsx}"],
    ...solid,
    languageOptions: {
      ...solid.languageOptions,
      globals: { ...globals.browser },
    },
  },
);
