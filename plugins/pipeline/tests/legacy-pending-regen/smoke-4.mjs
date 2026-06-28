// Smoke tests: autostart renderTemplate, loadPipelineConfig, DB init idempotency, pipeline.md sibling flag

import { renderTemplate } from "../src/setup/autostart.mjs";
import { loadPipelineConfig } from "../src/pipeline-config.mjs";
import { connectPath, close } from "../../src/db/connection.mjs";
import { PIPELINE_DEFAULTS } from "../src/config-defaults.mjs";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let pass = 0, fail = 0;
function assert(label, cond) {
  if (cond) { console.log(`  ✓ ${label}`); pass++; }
  else       { console.error(`  ✗ ${label}`); fail++; }
}

const dir = mkdtempSync(join(tmpdir(), "smoke-4-"));

try {

  // ── renderTemplate ────────────────────────────────────────────────────────────
  console.log("\nrenderTemplate");

  const vars = {
    nodePath:    "C:\\node\\node.exe",
    bridgeEntry: "C:\\pipeline\\watch_queue.mjs",
    configDir:   "C:\\Users\\test\\.pipeline",
    logDir:      "C:\\Users\\test\\AppData\\Local\\pipeline\\logs",
  };

  const rendered = renderTemplate("win32", vars);
  assert("NODE_PATH substituted",      !rendered.includes("${NODE_PATH}"));
  assert("BRIDGE_ENTRY substituted",   !rendered.includes("${BRIDGE_ENTRY}"));
  assert("CONFIG_DIR substituted",     !rendered.includes("${CONFIG_DIR}"));
  assert("LOG_DIR substituted",        !rendered.includes("${LOG_DIR}"));
  assert("node path value present",    rendered.includes(vars.nodePath));
  assert("bridge entry value present", rendered.includes(vars.bridgeEntry));

  let threw = false;
  try { renderTemplate("freebsd", vars); } catch { threw = true; }
  assert("unknown platform throws", threw);

  // ── loadPipelineConfig ────────────────────────────────────────────────────────
  // loadPipelineConfig reads from ~/.pipeline/config.json (homedir() is not
  // injectable). We test the observable contract: function returns a complete
  // object with all PIPELINE_DEFAULTS keys, never throws regardless of file state.
  console.log("\nloadPipelineConfig");

  const cfg = loadPipelineConfig();
  assert("returns models object",            cfg.models != null);
  assert("dev_default matches DEFAULTS",     cfg.models.dev_default === PIPELINE_DEFAULTS.models.dev_default);
  assert("review_default matches DEFAULTS",  cfg.models.review_default === PIPELINE_DEFAULTS.models.review_default);
  assert("notifications key present",        "notifications" in cfg);
  assert("review key present",               "review" in cfg);

  // loadPipelineConfig — deep merge via injected configPath
  const tmpMerge = join(dir, "config-merge.json");
  writeFileSync(tmpMerge, JSON.stringify({ models: { dev_default: "test-model" } }), "utf8");
  const cfgMerge = loadPipelineConfig(tmpMerge);
  assert("deep merge: override key applied",     cfgMerge.models.dev_default === "test-model");
  assert("deep merge: unset key falls to default",
    cfgMerge.models.review_default === PIPELINE_DEFAULTS.models.review_default);

  // loadPipelineConfig — corrupt JSON falls back to defaults without throwing
  const tmpCorrupt = join(dir, "config-corrupt.json");
  writeFileSync(tmpCorrupt, "not-json", "utf8");
  let cfgCorrupt;
  try { cfgCorrupt = loadPipelineConfig(tmpCorrupt); } catch { cfgCorrupt = null; }
  assert("corrupt JSON: does not throw",        cfgCorrupt !== null);
  assert("corrupt JSON: dev_default is default",
    cfgCorrupt && cfgCorrupt.models.dev_default === PIPELINE_DEFAULTS.models.dev_default);

  // ── DB init idempotency ───────────────────────────────────────────────────────
  console.log("\nDB init idempotency");

  const dbPath = join(dir, "idempotent.db");

  const db1 = connectPath(dbPath);
  close(db1);

  const db2 = connectPath(dbPath);
  const versionRows = db2.prepare("SELECT * FROM schema_version").all();
  assert("schema_version has exactly 1 row after double-open", versionRows.length === 1);
  assert("schema_version.version = 1", versionRows[0].version === 1);

  const metaRow = db2.prepare("SELECT value FROM pipeline_meta WHERE key = 'pipeline_enabled'").get();
  assert("pipeline_enabled defaults to '0'", metaRow && metaRow.value === "0");
  close(db2);

  // ── pipeline.md sibling → pipeline_enabled flip ───────────────────────────────
  console.log("\npipeline.md sibling flag");

  const sibDir = join(dir, "proj-with-sibling");
  mkdirSync(sibDir, { recursive: true });
  const sibDbPath = join(sibDir, "pipeline.db");
  writeFileSync(join(sibDir, "pipeline.md"), "# pipeline\n");

  const sibDb = connectPath(sibDbPath);
  const enabledRow = sibDb.prepare("SELECT value FROM pipeline_meta WHERE key = 'pipeline_enabled'").get();
  assert("pipeline_enabled flipped to '1' when pipeline.md sibling present", enabledRow && enabledRow.value === "1");
  assert("pipeline.md deleted after flip", !existsSync(join(sibDir, "pipeline.md")));
  close(sibDb);

  // Second open: migration fence must NOT re-apply (pipeline_enabled stays '1')
  const sibDb2 = connectPath(sibDbPath);
  const enabledRow2 = sibDb2.prepare("SELECT value FROM pipeline_meta WHERE key = 'pipeline_enabled'").get();
  assert("pipeline_enabled still '1' on second open (no re-flip)", enabledRow2 && enabledRow2.value === "1");
  const versionRows2 = sibDb2.prepare("SELECT * FROM schema_version").all();
  assert("schema_version still 1 row on second open", versionRows2.length === 1);
  close(sibDb2);

} finally {
  rmSync(dir, { recursive: true, force: true });
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
