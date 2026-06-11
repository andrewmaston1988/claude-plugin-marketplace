// Asserts that the governor-session.md template only references $VAR names
// that governor.mjs's spawn env actually sets (the "spawn contract").
import { test } from "node:test";
import { ok, strictEqual } from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const TEMPLATE_PATH = fileURLToPath(
  new URL("../templates/governor-session.md", import.meta.url)
);

const CONTRACT_VARS = new Set([
  "CORRELATION_ID",
  "REPORT_TYPE",
  "REPORT_DATE",
  "REPORT_MONTH",
  "PIPELINE_DB",
  "PLUGIN_DIR",
]);

// Well-known OS / shell vars that any process can expect in its env,
// plus prose template placeholders that appear as $VAR in doc strings.
const ALWAYS_PRESENT = new Set([
  "PATH", "HOME", "USER", "SHELL", "USERPROFILE", "APPDATA", "TEMP", "TMP",
  "BASELINE", // appears in report-format doc strings, not a real spawn var
]);

test("governor-session.md template exists", () => {
  ok(existsSync(TEMPLATE_PATH), `template not found at ${TEMPLATE_PATH}`);
});

test("governor-session.md: all $VAR references are in the spawn contract", () => {
  const content = readFileSync(TEMPLATE_PATH, "utf8");
  // Only flag multi-char uppercase names that look like real env vars (not $X, $Y doc placeholders).
  const varRefs = [...content.matchAll(/\$([A-Z_][A-Z0-9_]{2,})/g)].map(m => m[1]);
  const unique = [...new Set(varRefs)].filter(v => !ALWAYS_PRESENT.has(v));
  const unknown = unique.filter(v => !CONTRACT_VARS.has(v));
  strictEqual(
    unknown.length, 0,
    `template references vars not in spawn contract: ${unknown.join(", ")}`
  );
});

test("governor.mjs sets all spawn-contract vars", () => {
  const govPath = fileURLToPath(
    new URL("../scripts/orchestrator/governor.mjs", import.meta.url)
  );
  const src = readFileSync(govPath, "utf8");
  for (const varName of CONTRACT_VARS) {
    ok(
      src.includes(`env.${varName}`),
      `governor.mjs does not set env.${varName}`
    );
  }
});
