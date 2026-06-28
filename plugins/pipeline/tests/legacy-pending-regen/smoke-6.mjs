// Smoke tests: session-gen.mjs — dead replacement removal + {CORRELATION_ID} regression

import { generateSessionFile } from "../../src/session-gen.mjs";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let pass = 0, fail = 0;
function assert(label, cond) {
  if (cond) { console.log(`  ✓ ${label}`); pass++; }
  else       { console.error(`  ✗ ${label}`); fail++; }
}

const baseDir = mkdtempSync(join(tmpdir(), "smoke-6-"));

try {
  const claudeBase = baseDir;
  mkdirSync(join(baseDir, "templates"), { recursive: true });

  // Template contains all formerly-dead tokens, {CORRELATION_ID}, and a bash runtime variable
  const TEMPLATE = [
    "corr={CORRELATION_ID}",
    "pf={PLAN_FILE}",
    "tb={TARGET_BRANCH}",
    "fe={FEATURE}",
    "parent=${CLAUDE_PARENT}",
  ].join("\n");

  writeFileSync(join(baseDir, "templates", "autonomous-dev.md"), TEMPLATE, "utf8");

  // ── generateSessionFile expansion check ──────────────────────────────────────
  console.log("\nsession-gen placeholder smoke");

  const sessionPath = generateSessionFile("test-proj", "my-feature.md", "dev", { claudeBase });
  const out = readFileSync(sessionPath, "utf8");

  // {CORRELATION_ID} must be expanded (not literal in output)
  assert("{CORRELATION_ID} expanded (not literal)", !out.includes("{CORRELATION_ID}"));

  // Dead tokens {PLAN_FILE}, {TARGET_BRANCH}, {FEATURE}: no .replace() calls for them,
  // so they survive literally in the output (confirms dead code was not re-introduced)
  assert("{PLAN_FILE} passes through unexpanded",     out.includes("{PLAN_FILE}"));
  assert("{TARGET_BRANCH} passes through unexpanded", out.includes("{TARGET_BRANCH}"));
  assert("{FEATURE} passes through unexpanded",       out.includes("{FEATURE}"));

  // Bash runtime variable must NOT be pre-expanded by session-gen
  assert("${CLAUDE_PARENT} survives unexpanded", out.includes("${CLAUDE_PARENT}"));

  // Session file is returned as a path string
  assert("returns a path string",           typeof sessionPath === "string");
  assert("session file ends with .md",      sessionPath.endsWith(".md"));

} finally {
  rmSync(baseDir, { recursive: true, force: true });
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
