// ESLint flat config — applies to every plugin in plugins/.
// Enforces the marketplace's hard rules (set out in CLAUDE.md) at lint time
// instead of relying on review discipline.

import js from "@eslint/js";
import globals from "globals";

export default [
  js.configs.recommended,
  {
    files: ["plugins/**/*.{mjs,js}"],
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "module",
      globals: {
        ...globals.node,
      },
    },
    rules: {
      // Stock noise reduction
      "no-unused-vars": ["warn", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
      "no-empty": ["warn", { allowEmptyCatch: true }],

      // ── Marketplace-specific rules (from CLAUDE.md) ─────────────────────────
      //
      // 1. Windows libuv workaround: one-shot subcommands must use
      //    `setTimeout(() => process.exit(N), 150)`, never `setImmediate`.
      "no-restricted-syntax": [
        "error",
        {
          selector: "CallExpression[callee.name='setImmediate'] > ArrowFunctionExpression CallExpression[callee.object.name='process'][callee.property.name='exit']",
          message: "Use `setTimeout(() => process.exit(N), 150)` instead of `setImmediate(...)` (Windows libuv UV_HANDLE_CLOSING workaround — see CLAUDE.md).",
        },
        {
          selector: "Identifier[name='__dirname']",
          message: "ESM has no `__dirname`. Use `fileURLToPath(new URL('.', import.meta.url))` instead.",
        },
        {
          selector: "Identifier[name='__filename']",
          message: "ESM has no `__filename`. Use `fileURLToPath(import.meta.url)` instead.",
        },
        // Top-level return is illegal in ESM — caught by the parser, but flagged
        // explicitly so the error message points to the right CLAUDE.md rule.
      ],

      // Zero npm runtime dependencies — enforced by convention:
      // plugins/<name>/package.json must not have a `dependencies` block.
      // Runtime checks fail loudly if a non-resolved bare import slips through.
      // Doing this via eslint via `no-restricted-imports` is fiddly because
      // negative patterns are hard; the package.json invariant is the better gate.
    },
  },
];
