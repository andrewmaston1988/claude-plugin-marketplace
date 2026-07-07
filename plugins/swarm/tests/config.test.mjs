import { test } from "node:test";
import { equal, deepEqual, throws } from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadConfig, deepMerge, swarmHome } from "../src/config.mjs";

function tmp() {
  return mkdtempSync(join(tmpdir(), "swarm-cfg-"));
}

test("loadConfig returns shipped defaults when user config is missing", () => {
  const dir = tmp();
  try {
    const cfg = loadConfig(join(dir, "nope.json"));
    equal(cfg.provider.name, "ollama");
    equal(cfg.provider.mode, "env");
    equal(cfg.provider.url, "http://localhost:11434");
    equal(cfg.provider.authToken, "ollama");
    equal(cfg.provider.cloudSuffix, ":cloud");
    deepEqual(cfg.provider.allowedRoots, []);
    equal(cfg.concurrency, 4);
    equal(cfg.timeoutMs, 600000);
    equal(cfg.resultInlineCap, 4000);
    equal(cfg.worktreeBranchPrefix, "swarm/");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("user config deep-merges over defaults without clobbering siblings", () => {
  const dir = tmp();
  try {
    const p = join(dir, "config.json");
    writeFileSync(p, JSON.stringify({
      provider: { allowedRoots: ["C:/code"], url: "http://localhost:9999" },
      concurrency: 2,
    }));
    const cfg = loadConfig(p);
    deepEqual(cfg.provider.allowedRoots, ["C:/code"]);
    equal(cfg.provider.url, "http://localhost:9999");
    equal(cfg.provider.mode, "env");           // sibling default preserved
    equal(cfg.provider.authToken, "ollama");   // sibling default preserved
    equal(cfg.concurrency, 2);
    equal(cfg.timeoutMs, 600000);              // top-level default preserved
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("loadConfig resolves ~/.swarm/config.json via SWARM_HOME", () => {
  const dir = tmp();
  try {
    mkdirSync(join(dir, "home"), { recursive: true });
    writeFileSync(join(dir, "home", "config.json"), JSON.stringify({ concurrency: 7 }));
    const cfg = loadConfig(undefined, { SWARM_HOME: join(dir, "home") });
    equal(cfg.concurrency, 7);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("malformed user config throws with the path in the message", () => {
  const dir = tmp();
  try {
    const p = join(dir, "config.json");
    writeFileSync(p, "{ not json");
    throws(() => loadConfig(p), (e) => e.message.includes(p));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("deepMerge: arrays replace, nested objects merge", () => {
  const merged = deepMerge(
    { a: { x: 1, y: 2 }, list: [1, 2, 3] },
    { a: { y: 9 }, list: [4] },
  );
  deepEqual(merged, { a: { x: 1, y: 9 }, list: [4] });
});

test("swarmHome honours SWARM_HOME env", () => {
  equal(swarmHome({ SWARM_HOME: "X:/sw" }), "X:/sw");
});
