// verify the parse-error contract for loadPipelineConfig / updatePipelineConfig.
//
// Plan: pipeline-config-parse-error-abort — abort on parse error instead of
// silently resetting to `{}` on the write path. Reads fall back to defaults
// and emit a stderr warning.
import { test } from "node:test";
import { equal, deepEqual, match, ok } from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadPipelineConfig, updatePipelineConfig } from "../src/pipeline-config.mjs";
import { PIPELINE_DEFAULTS } from "../src/config-defaults.mjs";

function withTempConfig(content, fn) {
  const dir = mkdtempSync(join(tmpdir(), "pipeline-config-parse-"));
  const file = join(dir, "config.json");
  if (content !== null) writeFileSync(file, content);
  try { return fn(file); }
  finally { rmSync(dir, { recursive: true, force: true }); }
}

test("updatePipelineConfig: malformed JSON throws and file is unchanged on disk", () => {
  withTempConfig("{ not valid json", (file) => {
    const original = readFileSync(file, "utf8");
    let thrown = null;
    try {
      updatePipelineConfig(() => { throw new Error("mutator should not run"); }, file);
    } catch (err) { thrown = err; }
    ok(thrown, "updatePipelineConfig must throw on invalid JSON");
    match(thrown.message, /could not parse/);
    match(thrown.message, /config\.json/);
    equal(readFileSync(file, "utf8"), original, "on-disk file must be unchanged");
  });
});

test("updatePipelineConfig: malformed JSON never invokes the mutator", () => {
  withTempConfig("not even close to json", (file) => {
    let mutatorRan = false;
    let thrown = null;
    try {
      updatePipelineConfig(() => { mutatorRan = true; }, file);
    } catch (err) { thrown = err; }
    ok(thrown, "updatePipelineConfig must throw on invalid JSON");
    match(thrown.message, /could not parse/);
    equal(mutatorRan, false, "mutator must not run when parse fails");
  });
});

test("updatePipelineConfig: valid JSON round-trip still works (regression guard)", () => {
  withTempConfig(JSON.stringify({ orch: { max_concurrent: 5 } }), (file) => {
    const out = updatePipelineConfig((cfg) => { cfg.orch.max_concurrent = 7; }, file);
    equal(out.orch.max_concurrent, 7);
    const reloaded = JSON.parse(readFileSync(file, "utf8"));
    equal(reloaded.orch.max_concurrent, 7);
  });
});

test("loadPipelineConfig: malformed JSON returns defaults and writes a warning to stderr", () => {
  withTempConfig("<<<<<<<", (file) => {
    const captured = [];
    const original = process.stderr.write.bind(process.stderr);
    process.stderr.write = (chunk) => { captured.push(String(chunk)); return true; };
    try {
      const cfg = loadPipelineConfig(file);
      deepEqual(cfg, PIPELINE_DEFAULTS);
      const joined = captured.join("");
      ok(joined.includes("could not parse"), `expected warning in stderr, got: ${joined}`);
      ok(joined.includes(file), `expected file path in warning, got: ${joined}`);
    } finally {
      process.stderr.write = original;
    }
  });
});

