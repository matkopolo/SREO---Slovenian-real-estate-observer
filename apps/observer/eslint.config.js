// Lint gate: JS + typescript-eslint recommended with type information (floating and misused promises, unsafe any,
// exhaustive switches), strict equality, and the React hooks rules including the React Compiler checks from
// eslint-plugin-react-hooks 7 (refs, immutability, set-state-in-effect, ...). jsx-a11y is not installed; the
// accessibility review is manual (docs/frontend.md).
import js from "@eslint/js";
import reactHooks from "eslint-plugin-react-hooks";
import globals from "globals";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["dist", "node_modules", "src/generated"] },
  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  reactHooks.configs.flat["recommended-latest"],
  {
    files: ["**/*.{ts,tsx}"],
    languageOptions: { ecmaVersion: 2022, sourceType: "module", globals: globals.browser, parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname } },
    rules: {
      "react-hooks/exhaustive-deps": "error",
      "@typescript-eslint/no-floating-promises": "error",
      "@typescript-eslint/no-misused-promises": "error",
      "@typescript-eslint/switch-exhaustiveness-check": "error",
      eqeqeq: ["error", "always", { null: "ignore" }],
    },
  },
  { files: ["**/*.js"], ...tseslint.configs.disableTypeChecked },
  { files: ["vite.config.ts", "eslint.config.js"], languageOptions: { globals: globals.node } },
  { linterOptions: { reportUnusedDisableDirectives: "error" } },
);
