// Smoke tests: doctor.mjs — runDoctor shape, checks, printDoctor output

import { runDoctor, printDoctor } from "../src/setup/doctor.mjs";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let pass = 0, fail = 0;
function assert(label, cond) {
  if (cond) { console.log(`  ✓ ${label}`); pass++; }
  else       { console.error(`  ✗ ${label}`); fail++; }
}

const dir = mkdtempSync(join(tmpdir(), "smoke-5-"));

try {

  // ── runDoctor shape ──────────────────────────────────────────────────────────
  console.log("\nrunDoctor shape");

  const results = await runDoctor({ paths: { stateDir: dir } });

  assert("returns array",     Array.isArray(results));
  assert("returns 5 results", results.length === 5);

  for (const r of results) {
    assert(
      `result "${r.label ?? "?"}" has {label:string, ok:boolean, detail:string}`,
      typeof r.label === "string" && typeof r.ok === "boolean" && typeof r.detail === "string",
    );
  }

  // ── specific checks ──────────────────────────────────────────────────────────
  console.log("\nspecific checks");

  // results[0]: Node ≥22
  assert("Node ≥22 label",   results[0].label === "Node.js ≥ 22");
  assert("Node ≥22 ok=true", results[0].ok === true);

  // results[1]: claude CLI — shape only; ok depends on PATH
  assert("claude CLI label",    results[1].label === "claude CLI");
  assert("claude CLI ok is bool", typeof results[1].ok === "boolean");

  // results[2]: claudeBase — ok=true when ~/.claude/CLAUDE.md symlink present
  assert("claudeBase label",   results[2].label === "claudeBase");
  assert("claudeBase ok=true", results[2].ok === true);

  // results[4]: stateDir writable — ok=true with real tmpdir
  assert("stateDir label",        results[4].label === "~/.pipeline/ writable");
  assert("stateDir writable=true", results[4].ok === true);

  // ── printDoctor output ───────────────────────────────────────────────────────
  console.log("\nprintDoctor output");

  let captured = "";
  const origWrite = process.stdout.write.bind(process.stdout);
  process.stdout.write = (s) => { captured += s; return true; };
  printDoctor(results);
  process.stdout.write = origWrite;

  assert("output contains ✓ or ✗", captured.includes("✓") || captured.includes("✗"));
  assert("output has one line per result", captured.trim().split("\n").length === results.length);

  // ── non-writable stateDir ────────────────────────────────────────────────────
  console.log("\nnon-writable stateDir");

  // Place a FILE at the stateDir path so mkdirSync throws
  const filePath = join(dir, "not-a-dir");
  writeFileSync(filePath, "blocker");

  const results2 = await runDoctor({ paths: { stateDir: filePath } });
  assert("non-writable stateDir ok=false", results2[4].ok === false);
  assert("non-writable stateDir detail is string", typeof results2[4].detail === "string");

} finally {
  rmSync(dir, { recursive: true, force: true });
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
