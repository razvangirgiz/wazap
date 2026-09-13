import js from "@eslint/js";
import tseslint from "typescript-eslint";
import prettier from "eslint-config-prettier";
import globals from "globals";

export default tseslint.config(
  {
    ignores: ["dist/", "dist-bundle/", "node_modules/"],
  },
  {
    languageOptions: {
      globals: globals.node,
    },
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      // The codebase marks intentional exhaustiveness sinks and ignored
      // parameters with a leading underscore.
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
    },
  },
  prettier
);
