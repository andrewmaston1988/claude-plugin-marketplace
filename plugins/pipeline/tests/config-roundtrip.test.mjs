// verify loadPipelineConfig deep-merge behaviour.
//
// The only config loader is `src/pipeline-config.mjs`. Its contract:
//   - no file → deep clone of PIPELINE_DEFAULTS
//   - partial user file → user values override; untouched defaults preserved
//   - malformed JSON → defaults, no throw
import { test } from "node:test";
import { equal, deepEqual } from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadPipelineConfig } from "../src/pipeline-config.mjs";
import { PIPELINE_DEFAULTS } from "../src/config-defaults.mjs";

function withTempConfig(content, fn) {
  const dir = mkdtempSync(join(tmpdir(), "pipeline-config-"));
  const file = join(dir, "config.json");
  if (content !== null) writeFileSync(file, content);
  try { return fn(file); }
  finally { rmSync(dir, { recursive: true, force: true }); }
}

test("loadPipelineConfig: no file → defaults", () => {
  const cfg = loadPipelineConfig(join(tmpdir(), "pipeline-config-missing-xyz", "config.json"));
  deepEqual(cfg, PIPELINE_DEFAULTS);
});

test("loadPipelineConfig: partial user file → deep merge preserves untouched defaults", () => {
  withTempConfig(JSON.stringify({ notifications: { slack_channel: "foo" } }), (file) => {
    const cfg = loadPipelineConfig(file);
    equal(cfg.notifications.slack_channel, "foo");
    equal(cfg.models.dev_default,    PIPELINE_DEFAULTS.models.dev_default);
    equal(cfg.models.review_default, PIPELINE_DEFAULTS.models.review_default);
    equal(cfg.review.skill,          PIPELINE_DEFAULTS.review.skill);
    equal(cfg.review.deep_flag,      PIPELINE_DEFAULTS.review.deep_flag);
  });
});

test("loadPipelineConfig: malformed JSON → defaults, no throw", () => {
  withTempConfig("{ not valid json", (file) => {
    const cfg = loadPipelineConfig(file);
    deepEqual(cfg, PIPELINE_DEFAULTS);
  });
});

test("loadPipelineConfig: empty object → defaults", () => {
  withTempConfig("{}", (file) => {
    const cfg = loadPipelineConfig(file);
    deepEqual(cfg, PIPELINE_DEFAULTS);
  });
});
