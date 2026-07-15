import { test } from "node:test";
import { equal, deepEqual, throws } from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync, mkdirSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { loadConfig, deepMerge, swarmHome, DEFAULT_TIMEOUT_MS } from "../src/config.mjs";
import { loadManifest } from "../src/manifest.mjs";

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
    equal(cfg.timeoutMs, DEFAULT_TIMEOUT_MS);
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
    equal(cfg.timeoutMs, DEFAULT_TIMEOUT_MS);  // top-level default preserved
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

// --- timeout headroom: one constant, pinned to the shipped default ---

test("DEFAULT_TIMEOUT_MS is the one-hour headroom value", () => {
  equal(DEFAULT_TIMEOUT_MS, 3_600_000);
});

test("a user config that sets timeoutMs wins over the shipped default", () => {
  const dir = tmp();
  try {
    const p = join(dir, "config.json");
    writeFileSync(p, JSON.stringify({ timeoutMs: 12345 }));
    const cfg = loadConfig(p);
    equal(cfg.timeoutMs, 12345);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a task's own timeoutMs wins over manifest-level and config defaults", () => {
  const dir = tmp();
  try {
    const p = join(dir, "plan.json");
    writeFileSync(p, JSON.stringify({
      timeoutMs: 100000, // manifest-level (raw) fallback
      tasks: [
        { id: "a", prompt: "look", model: "haiku", timeoutMs: 2700000 }, // per-task override
        { id: "b", prompt: "look more", model: "haiku" }, // no own timeout
      ],
    }));
    const cfg = { provider: { allowedRoots: [] }, concurrency: 4, timeoutMs: 50000, resultInlineCap: 4000 };
    const plan = loadManifest(p, cfg, dir);
    // per-task beats per-manifest beats config beats default (manifest.mjs resolution chain)
    equal(plan.tasks[0].timeoutMs, 2700000);
    // a task without its own falls back to the manifest-level value, not the config
    equal(plan.tasks[1].timeoutMs, 100000);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("no bare 600000 literal survives anywhere under src/", () => {
  const srcDir = fileURLToPath(new URL("../src", import.meta.url));
  const hits = [];
  (function walk(d) {
    for (const name of readdirSync(d)) {
      const f = join(d, name);
      if (statSync(f).isDirectory()) { walk(f); continue; }
      if (!f.endsWith(".mjs")) continue;
      if (readFileSync(f, "utf8").includes("600000")) hits.push(f);
    }
  })(srcDir);
  equal(hits.length, 0, `bare 600000 literal remains in: ${hits.join(", ")}`);
});