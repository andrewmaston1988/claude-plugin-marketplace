import { test } from "node:test";
import { equal, ok } from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { PIPELINE_DEFAULTS } from "../src/config-defaults.mjs";
import { loadPipelineConfig } from "../src/pipeline-config.mjs";

test("PIPELINE_DEFAULTS has web.port", () => {
  ok(PIPELINE_DEFAULTS.web, "web key present");
  equal(typeof PIPELINE_DEFAULTS.web.port, "number");
  equal(PIPELINE_DEFAULTS.web.port, 8765);
});

test("PIPELINE_DEFAULTS has web.host", () => {
  equal(PIPELINE_DEFAULTS.web.host, "127.0.0.1");
});

test("loadPipelineConfig: web.port default present when no config file", () => {
  const cfg = loadPipelineConfig(join(tmpdir(), "pipeline-cfg-missing-xyz", "config.json"));
  equal(cfg.web.port, 8765);
});

test("loadPipelineConfig: web.host default present when no config file", () => {
  const cfg = loadPipelineConfig(join(tmpdir(), "pipeline-cfg-missing-xyz", "config.json"));
  equal(cfg.web.host, "127.0.0.1");
});

test("loadPipelineConfig: web.port override from config file", () => {
  const dir = mkdtempSync(join(tmpdir(), "pipeline-cfg-webport-"));
  const file = join(dir, "config.json");
  writeFileSync(file, JSON.stringify({ web: { port: 9000 } }));
  try {
    const cfg = loadPipelineConfig(file);
    equal(cfg.web.port, 9000);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("loadPipelineConfig: web.host override from config file", () => {
  const dir = mkdtempSync(join(tmpdir(), "pipeline-cfg-webhost-"));
  const file = join(dir, "config.json");
  writeFileSync(file, JSON.stringify({ web: { host: "0.0.0.0" } }));
  try {
    const cfg = loadPipelineConfig(file);
    equal(cfg.web.host, "0.0.0.0");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
