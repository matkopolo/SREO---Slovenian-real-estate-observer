// Minimal lint gate: JS + typescript-eslint recommended, and the React hooks rules including the
// React Compiler checks from eslint-plugin-react-hooks 7 (refs, immutability, set-state-in-effect, ...).
import js from "@eslint/js";
import reactHooks from "eslint-plugin-react-hooks";
import globals from "globals";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["dist", "node_modules", "src/generated"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  reactHooks.configs.flat["recommended-latest"],
  {
    files: ["**/*.{ts,tsx}"],
    languageOptions: { ecmaVersion: 2022, sourceType: "module", globals: globals.browser },
    rules: { "react-hooks/exhaustive-deps": "error" },
  },
  { files: ["vite.config.ts", "eslint.config.js"], languageOptions: { globals: globals.node } },
  { linterOptions: { reportUnusedDisableDirectives: "error" } },
);
