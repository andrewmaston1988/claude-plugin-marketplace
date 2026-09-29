// Rows for the models-cache surface that the locked discovery.test.mjs (568
// lines, over the ratchet bar) cannot grow to hold: the reader's error
// contract (corrupt vs missing), identity-normalised merge/eviction, and the
// single-writer rule. Sibling of discovery.test.mjs — keep its row shape.

import { test } from "node:test";
import { equal, deepEqual, ok, throws, rejects } from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mergeProviderModelCaches, removeCachedModel } from "../src/discovery.mjs";
import { readRosterEnvelope, refreshRoster } from "../src/roster.mjs";
import { createProviderRegistry } from "../src/providers.mjs";

const networkRegistry = () => createProviderRegistry([{
  id: "ollama",
  runnerId: "claude",
  rosterHydration: "network",
  enabled: () => true,
  validateTask: () => [],
  capabilities: { discoverModels: async () => [] },
}]);

// Truncated mid-row: the shape a killed write or a hand-edit leaves behind.
const CORRUPT = '{"updated":"2026-09-21T00:00:00.000Z","models":[{"model":"glm-5';

test("readRosterEnvelope throws on a corrupt cache file, naming the file", () => {
  const dir = mkdtempSync(join(tmpdir(), "swarm-corrupt-"));
  try {
    const env = { SWARM_HOME: dir };
    const p = join(dir, "models-cache.json");
    writeFileSync(p, CORRUPT);
    throws(() => readRosterEnvelope(env), (err) => err.message.includes(p));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("readRosterEnvelope reads an empty roster only for a missing file (first-ever install)", () => {
  const dir = mkdtempSync(join(tmpdir(), "swarm-nocache-"));
  try {
    deepEqual(readRosterEnvelope({ SWARM_HOME: dir }).providers, {});
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("refreshRoster on a corrupt cache throws instead of writing an empty roster", async () => {
  const dir = mkdtempSync(join(tmpdir(), "swarm-corrupt-refresh-"));
  try {
    const env = { SWARM_HOME: dir };
    const p = join(dir, "models-cache.json");
    writeFileSync(p, CORRUPT);
    await rejects(
      () => refreshRoster({ env, registry: networkRegistry(), force: true }),
    );
    equal(readFileSync(p, "utf8"), CORRUPT, "the corrupt file is left untouched — no empty write");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
function seedCache(dir, models) {
  const p = join(dir, "models-cache.json");
  writeFileSync(p, JSON.stringify({ updated: "2026-09-21T00:00:00.000Z", models }, null, 2) + "\n");
  return p;
}

test("mergeProviderModelCaches: cased provider variants are one row", () => {
  deepEqual(
    mergeProviderModelCaches([[{ provider: "Codex", model: "gpt-5" }, { provider: "codex", model: "gpt-5" }]]),
    [{ provider: "codex", model: "gpt-5" }],
  );
});

test("removeCachedModel removes a cased provider row by its canonical id", () => {
  const dir = mkdtempSync(join(tmpdir(), "swarm-evict-case-"));
  try {
    const env = { SWARM_HOME: dir };
    const p = seedCache(dir, [{ provider: "Codex", model: "gpt-5" }, { provider: "codex", model: "gpt-4" }]);
    removeCachedModel("gpt-5", env, "codex");
    deepEqual(JSON.parse(readFileSync(p, "utf8")).models, [{ provider: "codex", model: "gpt-4" }]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("removeCachedModel: a provider-less row still matches any eviction", () => {
  const dir = mkdtempSync(join(tmpdir(), "swarm-evict-legacy-"));
  try {
    const env = { SWARM_HOME: dir };
    const p = seedCache(dir, [{ model: "shared-id" }, { provider: "codex", model: "shared-id" }]);
    removeCachedModel("shared-id", env, "codex");
    deepEqual(JSON.parse(readFileSync(p, "utf8")).models, []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

import * as discovery from "../src/discovery.mjs";

test("writeModelsCache is deleted — one writer to models-cache.json", () => {
  equal(discovery.writeModelsCache, undefined);
});
