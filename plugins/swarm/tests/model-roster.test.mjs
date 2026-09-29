// The roster read-through: one synchronous reader over the per-provider cache
// envelope, one async refresher for the providers whose roster costs a network
// call, and each adapter's own staleness rule. Sibling of discovery.test.mjs —
// keep its row shape.

import { test } from "node:test";
import { deepEqual, equal, ok, throws, rejects } from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, readdirSync, utimesSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import * as roster from "../src/roster.mjs";
import { removeCachedModel } from "../src/discovery.mjs";
import { createProviderRegistry, createDefaultProviderRegistry, PROVIDER_CAPABILITIES } from "../src/providers.mjs";

// Named through the namespace so a missing export fails its own row rather than
// the whole file at link time.
const { modelRoster, refreshRoster, readRosterEnvelope, writeRosterEntry } = roster;

// The plan's own number, as a literal: a test stepping against the exported
// constant moves with it and never goes red.
const TWELVE_H = 12 * 60 * 60_000;

const cachePath = (dir) => join(dir, "models-cache.json");
const home = () => mkdtempSync(join(tmpdir(), "swarm-roster-"));
// HOME too, not just SWARM_HOME: the claude adapter's discovery reads
// ~/.claude/cache/model-catalog, and a real one would add rows here.
const envOf = (dir) => ({ SWARM_HOME: dir, HOME: dir, USERPROFILE: dir });

function cleanup(dir) {
  rmSync(dir, { recursive: true, force: true });
}

function writeCatalog(dir, file, { fetchedAt, ids, mtimeMs }) {
  const catalogDir = join(dir, ".claude", "cache", "model-catalog");
  mkdirSync(catalogDir, { recursive: true });
  const path = join(catalogDir, file);
  writeFileSync(path, JSON.stringify({
    fetchedAt,
    catalog: { config: { models: ids.map((id) => ({ id, name: id })) } },
  }));
  if (mtimeMs != null) utimesSync(path, new Date(mtimeMs), new Date(mtimeMs));
  return path;
}

function localAdapter(id, rows, log = []) {
  const source = () => `${id}-catalog@1`;
  return {
    id,
    runnerId: "claude",
    rosterHydration: "local",
    enabled: () => true,
    validateTask: () => [],
    capabilities: {
      discoverModels: () => { log.push(id); return rows; },
      rosterSource: source,
      rosterStale: (entry) => entry?.source !== source(),
    },
  };
}

function networkAdapter(id, { rows = [{ model: `${id}-new` }], fail = null, log = [], enabled = () => true } = {}) {
  return {
    id,
    runnerId: "claude",
    rosterHydration: "network",
    enabled,
    validateTask: () => [],
    capabilities: {
      discoverModels: async (context) => {
        log.push(context);
        if (fail) throw new Error(fail);
        return rows;
      },
    },
  };
}

const entryOf = (id, model, hydratedAt) => ({ hydratedAt, source: null, models: [{ provider: id, model }] });
const namesOf = (rows) => rows.map((row) => row.model);

test("ROSTER_TTL_MS is the 12h the network providers age on", () => {
  equal(roster.ROSTER_TTL_MS, TWELVE_H);
});

// ── Claude: local hydration keyed on the selected catalog's identity ──

test("modelRoster hydrates Claude and banks the selected catalog's file@fetchedAt", () => {
  const dir = home();
  try {
    const env = envOf(dir);
    writeCatalog(dir, "a-cc.json", { fetchedAt: 100, ids: ["claude-opus-5"], mtimeMs: 1_000_000 });
    const read = modelRoster({ env, registry: createDefaultProviderRegistry(), now: 1000 });
    deepEqual(namesOf(read.models), ["claude-opus-5"]);
    const entry = readRosterEnvelope(env).providers.claude;
    equal(entry.source, "a-cc.json@100", "the identity is the file the reader actually selected, with its fetchedAt");
    equal(entry.hydratedAt, 1000);
    equal(entry.models[0].provider, "claude");
  } finally {
    cleanup(dir);
  }
});

test("an unchanged Claude catalog is not re-hydrated", () => {
  const dir = home();
  try {
    const env = envOf(dir);
    writeCatalog(dir, "a-cc.json", { fetchedAt: 100, ids: ["claude-opus-5"], mtimeMs: 1_000_000 });
    modelRoster({ env, registry: createDefaultProviderRegistry(), now: 1000 });
    const again = modelRoster({ env, registry: createDefaultProviderRegistry(), now: 2000 });
    deepEqual(namesOf(again.models), ["claude-opus-5"]);
    equal(readRosterEnvelope(env).providers.claude.hydratedAt, 1000, "a second read must not rewrite the entry");
  } finally {
    cleanup(dir);
  }
});

test("a second catalog with a newer mtime but an older fetchedAt does not fool it", () => {
  const dir = home();
  try {
    const env = envOf(dir);
    writeCatalog(dir, "a-cc.json", { fetchedAt: 100, ids: ["claude-opus-5"], mtimeMs: 1_000_000 });
    writeCatalog(dir, "b-cc.json", { fetchedAt: 50, ids: ["claude-b"], mtimeMs: 9_000_000 });
    modelRoster({ env, registry: createDefaultProviderRegistry(), now: 1000 });
    const read = modelRoster({ env, registry: createDefaultProviderRegistry(), now: 3000 });
    deepEqual(namesOf(read.models), ["claude-opus-5"], "selection is by fetchedAt, never by mtime");
    const entry = readRosterEnvelope(env).providers.claude;
    equal(entry.source, "a-cc.json@100");
    equal(entry.hydratedAt, 1000, "the roster did not move under a newer mtime");
  } finally {
    cleanup(dir);
  }
});

test("a changed Claude catalog is re-hydrated whole on the next read", () => {
  const dir = home();
  try {
    const env = envOf(dir);
    writeCatalog(dir, "a-cc.json", { fetchedAt: 100, ids: ["claude-opus-5"], mtimeMs: 1_000_000 });
    modelRoster({ env, registry: createDefaultProviderRegistry(), now: 1000 });
    writeCatalog(dir, "c-cc.json", { fetchedAt: 300, ids: ["claude-sonnet-5-5"], mtimeMs: 5_000_000 });
    const read = modelRoster({ env, registry: createDefaultProviderRegistry(), now: 4000 });
    deepEqual(namesOf(read.models), ["claude-sonnet-5-5"], "the entry is replaced, not merged");
    const entry = readRosterEnvelope(env).providers.claude;
    equal(entry.source, "c-cc.json@300");
    equal(entry.hydratedAt, 4000);
  } finally {
    cleanup(dir);
  }
});

// ── The reader never hydrates over the network ──

test("modelRoster serves a stale network entry as-is and never calls discovery", () => {
  const dir = home();
  try {
    const env = envOf(dir);
    const log = [];
    const registry = createProviderRegistry([networkAdapter("net", { log })]);
    const stale = entryOf("net", "net-old", 1);
    writeRosterEntry("net", stale, env);
    const read = modelRoster({ env, registry, now: 1 + TWELVE_H * 4 });
    deepEqual(namesOf(read.models), ["net-old"]);
    deepEqual(log, [], "a synchronous reader must not reach the network");
    deepEqual(readRosterEnvelope(env).providers.net, stale, "the entry is left exactly as it was");
  } finally {
    cleanup(dir);
  }
});

test("modelRoster refuses a local hydration that returns a promise instead of awaiting it", () => {
  const dir = home();
  try {
    const env = envOf(dir);
    const registry = createProviderRegistry([{
      id: "async-local",
      runnerId: "claude",
      rosterHydration: "local",
      enabled: () => true,
      validateTask: () => [],
      capabilities: { discoverModels: async () => [{ model: "late" }] },
    }]);
    writeRosterEntry("async-local", entryOf("async-local", "kept", 1), env);
    const read = modelRoster({ env, registry, now: 1 + TWELVE_H * 2 });
    deepEqual(namesOf(read.models), ["kept"], "the cached rows are served when the local hydrate cannot be resolved");
    ok(/synchronous/.test(read.errors["async-local"] || ""), JSON.stringify(read.errors));
  } finally {
    cleanup(dir);
  }
});

// ── refreshRoster: the 12h TTL, force, and rich ──

test("refreshRoster re-hydrates an entry past 12h and skips a younger one", async () => {
  const dir = home();
  try {
    const env = envOf(dir);
    const log = [];
    const registry = createProviderRegistry([networkAdapter("net", { log })]);
    const now = 1_000_000_000;
    writeRosterEntry("net", entryOf("net", "net-old", now - (TWELVE_H - 1)), env);
    await refreshRoster({ env, registry, now });
    deepEqual(log, [], "an entry one millisecond inside the window is fresh");

    writeRosterEntry("net", entryOf("net", "net-old", now - TWELVE_H), env);
    const refreshed = await refreshRoster({ env, registry, now });
    equal(log.length, 1, "an entry at the window's edge is stale");
    deepEqual(namesOf(refreshed.models), ["net-new"]);
    equal(readRosterEnvelope(env).providers.net.hydratedAt, now);
  } finally {
    cleanup(dir);
  }
});

test("refreshRoster({ force: true }) re-hydrates every network provider", async () => {
  const dir = home();
  try {
    const env = envOf(dir);
    const log = [];
    const registry = createProviderRegistry([
      networkAdapter("alpha", { log }),
      networkAdapter("beta", { log }),
    ]);
    const now = 5000;
    writeRosterEntry("alpha", entryOf("alpha", "alpha-old", now - 1000), env);
    writeRosterEntry("beta", entryOf("beta", "beta-old", now - 1000), env);
    const refreshed = await refreshRoster({ env, registry, now, force: true });
    equal(log.length, 2, "force ignores the window");
    deepEqual(namesOf(refreshed.models).sort(), ["alpha-new", "beta-new"]);
    equal(readRosterEnvelope(env).providers.beta.hydratedAt, now);
  } finally {
    cleanup(dir);
  }
});

test("refreshRoster threads rich through to the provider's discovery", async () => {
  const dir = home();
  try {
    const env = envOf(dir);
    const log = [];
    const registry = createProviderRegistry([networkAdapter("net", { log })]);
    await refreshRoster({ env, registry, now: 10, force: true, rich: true });
    equal(log[0].rich, true);
    await refreshRoster({ env, registry, now: 20, force: true });
    equal(log[1].rich, false, "rich is false unless asked for");
  } finally {
    cleanup(dir);
  }
});

// ── Zero rows, failures, and the entries they must not damage ──

test("a failed hydrate keeps the rows and records lastError", async () => {
  const dir = home();
  try {
    const env = envOf(dir);
    const registry = createProviderRegistry([networkAdapter("net", { fail: "offline", log: [] })]);
    writeRosterEntry("net", entryOf("net", "net-old", 1), env);
    const refreshed = await refreshRoster({ env, registry, now: 99, force: true });
    equal(refreshed.errors.net, "offline");
    deepEqual(namesOf(refreshed.models), ["net-old"], "an offline provider must not erase its roster");
    const entry = readRosterEnvelope(env).providers.net;
    deepEqual(namesOf(entry.models), ["net-old"]);
    equal(entry.lastError, "offline", "the failure is banked where the next reader sees it");
  } finally {
    cleanup(dir);
  }
});

test("a zero-row hydrate over cached rows keeps them and names the provider", async () => {
  const dir = home();
  try {
    const env = envOf(dir);
    const registry = createProviderRegistry([networkAdapter("net", { rows: [], log: [] })]);
    writeRosterEntry("net", entryOf("net", "net-old", 1), env);
    const refreshed = await refreshRoster({ env, registry, now: 99, force: true });
    deepEqual(namesOf(refreshed.models), ["net-old"]);
    ok(refreshed.errors.net?.includes("net"), "the report must name the provider");
    const entry = readRosterEnvelope(env).providers.net;
    deepEqual(namesOf(entry.models), ["net-old"]);
    equal(entry.lastError, refreshed.errors.net);
  } finally {
    cleanup(dir);
  }
});

test("a first-ever zero-row hydrate is written with no error", async () => {
  const dir = home();
  try {
    const env = envOf(dir);
    const registry = createProviderRegistry([networkAdapter("net", { rows: [], log: [] })]);
    const refreshed = await refreshRoster({ env, registry, now: 42, force: true });
    deepEqual(refreshed.models, []);
    deepEqual(refreshed.errors, {}, "a legitimate empty is not a failure to report");
    const entry = readRosterEnvelope(env).providers.net;
    deepEqual(entry.models, []);
    equal(entry.hydratedAt, 42);
    equal(entry.lastError, undefined);
  } finally {
    cleanup(dir);
  }
});

test("re-hydrating one provider leaves the others' entries byte-identical", async () => {
  const dir = home();
  try {
    const env = envOf(dir);
    const log = [];
    const registry = createProviderRegistry([networkAdapter("alpha", { log })]);
    writeRosterEntry("alpha", entryOf("alpha", "alpha-old", 1), env);
    writeRosterEntry("beta", entryOf("beta", "beta-old", 1), env);
    const before = readFileSync(cachePath(dir), "utf8");
    await refreshRoster({ env, registry, now: 77, force: true });
    const after = readFileSync(cachePath(dir), "utf8");
    equal(after.slice(after.indexOf('"beta"')), before.slice(before.indexOf('"beta"')),
      "an entry nobody hydrated must come back verbatim");
    ok(after.includes("alpha-new") && !after.includes("alpha-old"));
  } finally {
    cleanup(dir);
  }
});

// ── Disabled providers keep their rows ──

test("a disabled provider's rows survive both a read and a refresh", async () => {
  const dir = home();
  try {
    const env = envOf(dir);
    const log = [];
    const registry = createProviderRegistry([
      networkAdapter("net", { log, enabled: () => false }),
    ]);
    const entry = entryOf("net", "net-old", 1);
    writeRosterEntry("net", entry, env);
    const read = modelRoster({ env, registry, now: 1 + TWELVE_H * 4 });
    deepEqual(namesOf(read.models), ["net-old"]);
    const refreshed = await refreshRoster({ env, registry, now: 1 + TWELVE_H * 4, force: true });
    deepEqual(log, [], "a provider the config switched off is not hydrated");
    deepEqual(namesOf(refreshed.models), ["net-old"]);
    deepEqual(readRosterEnvelope(env).providers.net, entry, "rows survive a re-enable");
  } finally {
    cleanup(dir);
  }
});

// ── The old file shape ──

test("an old { updated, models } file carries its rows forward, banked at the file's age", () => {
  const dir = home();
  try {
    const env = envOf(dir);
    writeFileSync(cachePath(dir), JSON.stringify({
      updated: "2026-09-21T00:00:00.000Z",
      models: [{ provider: "ollama", model: "glm-5.2:cloud" }, { provider: "ollama", model: "kimi-k3:cloud" }],
    }));
    const aged = 1_700_000_000_000;
    utimesSync(cachePath(dir), new Date(aged), new Date(aged));
    const read = modelRoster({ env, registry: createDefaultProviderRegistry(), now: aged + 1000 });
    deepEqual(namesOf(read.models).sort(), ["glm-5.2:cloud", "kimi-k3:cloud"]);
    deepEqual(read.errors, {});
    const written = JSON.parse(readFileSync(cachePath(dir), "utf8"));
    ok(written.providers && !written.models, "the file is rewritten in the envelope shape");
    deepEqual(namesOf(written.providers.ollama.models).sort(), ["glm-5.2:cloud", "kimi-k3:cloud"]);
    equal(written.providers.ollama.hydratedAt, aged, "the rows read as their true age, not as fresh");
  } finally {
    cleanup(dir);
  }
});

test("a carried-forward provider renews on the normal TTL", async () => {
  const dir = home();
  try {
    const env = envOf(dir);
    writeFileSync(cachePath(dir), JSON.stringify({ models: [{ provider: "net", model: "net-old" }] }));
    const aged = 1_700_000_000_000;
    utimesSync(cachePath(dir), new Date(aged), new Date(aged));
    const log = [];
    const registry = createProviderRegistry([networkAdapter("net", { log })]);
    await refreshRoster({ env, registry, now: aged + TWELVE_H - 1 });
    equal(log.length, 0, "younger than 12h by the file's mtime: not stale");
    const refreshed = await refreshRoster({ env, registry, now: aged + TWELVE_H });
    equal(log.length, 1);
    deepEqual(namesOf(refreshed.models), ["net-new"]);
  } finally {
    cleanup(dir);
  }
});

test("an old-shape row with no provider is dropped and reported", () => {
  const dir = home();
  try {
    const env = envOf(dir);
    writeFileSync(cachePath(dir), JSON.stringify({
      models: [{ provider: "ollama", model: "kept" }, { model: "orphan" }],
    }));
    const read = modelRoster({ env, registry: createProviderRegistry([]) });
    deepEqual(namesOf(read.models), ["kept"]);
    ok(JSON.stringify(read.errors).includes("orphan"), "the drop is reported");
  } finally {
    cleanup(dir);
  }
});

test("a truncated cache file never empties the roster: the reader reports it, the refresher throws", async () => {
  const dir = home();
  try {
    const env = envOf(dir);
    const corrupt = '{"updated":"2026-09-21T00:00:00.000Z","models":[{"model":"glm-5';
    writeFileSync(cachePath(dir), corrupt);
    throws(() => readRosterEnvelope(env), (error) => error.message.includes(cachePath(dir)));
    const read = modelRoster({ env, registry: createDefaultProviderRegistry() });
    deepEqual(read.models, []);
    ok(read.errors.file.includes(cachePath(dir)));
    await rejects(
      () => refreshRoster({ env, registry: createProviderRegistry([networkAdapter("net")]) }),
      (error) => error.message.includes(cachePath(dir)),
    );
    equal(readFileSync(cachePath(dir), "utf8"), corrupt, "the corrupt file is left untouched — no empty write");
  } finally {
    cleanup(dir);
  }
});

// ── A failing provider is retried once per TTL, not per request ──

test("a failed hydrate stamps lastAttemptAt, so the next refresh inside the TTL skips it", async () => {
  const dir = home();
  try {
    const env = envOf(dir);
    const log = [];
    const registry = createProviderRegistry([networkAdapter("net", { fail: "offline", log })]);
    writeRosterEntry("net", entryOf("net", "net-old", 1), env);
    const t0 = 5 * TWELVE_H;
    await refreshRoster({ env, registry, now: t0 });
    equal(readRosterEnvelope(env).providers.net.lastAttemptAt, t0);
    await refreshRoster({ env, registry, now: t0 + 60_000 });
    equal(log.length, 1, "a dead provider is not re-probed inside the TTL");
    await refreshRoster({ env, registry, now: t0 + TWELVE_H });
    equal(log.length, 2, "and is retried once the TTL passes");
  } finally {
    cleanup(dir);
  }
});

test("a first-ever failure is also throttled", async () => {
  const dir = home();
  try {
    const env = envOf(dir);
    const log = [];
    const registry = createProviderRegistry([networkAdapter("net", { fail: "offline", log })]);
    await refreshRoster({ env, registry, now: 1000 });
    await refreshRoster({ env, registry, now: 2000 });
    equal(log.length, 1);
  } finally {
    cleanup(dir);
  }
});

test("a zero-row hydrate over cached rows stamps lastAttemptAt and is not re-probed", async () => {
  const dir = home();
  try {
    const env = envOf(dir);
    const log = [];
    const registry = createProviderRegistry([networkAdapter("net", { rows: [], log })]);
    writeRosterEntry("net", entryOf("net", "net-old", 1), env);
    const t0 = 5 * TWELVE_H;
    await refreshRoster({ env, registry, now: t0 });
    equal(readRosterEnvelope(env).providers.net.lastAttemptAt, t0);
    await refreshRoster({ env, registry, now: t0 + 60_000 });
    equal(log.length, 1);
  } finally {
    cleanup(dir);
  }
});

// ── The Cost path calls the reader on every request ──

test("a warm read of a 200-row envelope stays under 20ms", () => {
  const dir = home();
  try {
    const env = envOf(dir);
    const models = Array.from({ length: 200 }, (_, i) => ({ provider: "net", model: `m-${i}` }));
    const registry = createProviderRegistry([networkAdapter("net")]);
    writeRosterEntry("net", { hydratedAt: 1, source: null, models }, env);
    modelRoster({ env, registry, now: 2 });
    const started = performance.now();
    const read = modelRoster({ env, registry, now: 2 });
    const elapsed = performance.now() - started;
    equal(read.models.length, 200);
    ok(elapsed < 20, `warm read took ${elapsed.toFixed(2)}ms`);
  } finally {
    cleanup(dir);
  }
});

// ── Eviction against the envelope ──

test("removeCachedModel edits one provider's entry only", () => {
  const dir = home();
  try {
    const env = envOf(dir);
    writeRosterEntry("ollama", { hydratedAt: 1, source: null, models: [{ provider: "ollama", model: "shared" }] }, env);
    writeRosterEntry("codex", { hydratedAt: 1, source: null, models: [{ provider: "codex", model: "shared" }] }, env);
    removeCachedModel("shared", env, "codex");
    const providers = readRosterEnvelope(env).providers;
    deepEqual(namesOf(providers.codex.models), []);
    deepEqual(namesOf(providers.ollama.models), ["shared"], "a 402 on one provider never evicts another's row");
  } finally {
    cleanup(dir);
  }
});

// ── The registry contract ──

test("the registry accepts rosterSource and rosterStale, and still refuses an unknown capability", () => {
  ok(PROVIDER_CAPABILITIES.has("rosterSource") && PROVIDER_CAPABILITIES.has("rosterStale"));
  const adapter = localAdapter("cap", []);
  const registry = createProviderRegistry([adapter]);
  equal(registry.capability("cap", "rosterSource")(), "cap-catalog@1");
  equal(registry.capability("cap", "rosterStale")({ source: "cap-catalog@1" }), false);
  throws(() => registry.capability("cap", "invented"), /unknown provider capability/);
  throws(() => createProviderRegistry([{ ...adapter, capabilities: { invented: () => {} } }]), /unknown capability 'invented'/);
  throws(() => createProviderRegistry([{ ...adapter, rosterHydration: "sometimes" }]), /rosterHydration/);
});

test("the shipped adapters declare their hydration: Claude local, Ollama and Codex network", () => {
  const adapters = new Map(createDefaultProviderRegistry().list().map((adapter) => [adapter.id, adapter]));
  equal(adapters.get("claude").rosterHydration, "local");
  equal(adapters.get("ollama").rosterHydration, "network");
  equal(adapters.get("codex").rosterHydration, "network");
  equal(typeof adapters.get("claude").capabilities.rosterSource, "function");
});

// ── One reader, one writer ──

const ROSTER_READERS = new Set([
  "src/roster.mjs",
]);

function sourceFiles(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...sourceFiles(path));
    else if (entry.name.endsWith(".mjs")) out.push(path);
  }
  return out;
}

test("no module reads models-cache.json outside the roster envelope functions", () => {
  const root = fileURLToPath(new URL("..", import.meta.url));
  const found = new Set();
  for (const sub of ["src", "scripts", "hooks"]) {
    for (const path of sourceFiles(join(root, sub))) {
      const code = readFileSync(path, "utf8")
        .split("\n")
        .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
        .join("\n");
      if (code.includes("models-cache.json")) found.add(relative(root, path).split(sep).join("/"));
    }
  }
  deepEqual([...found].sort(), [...ROSTER_READERS].sort(),
    "the roster file has one reader — move any caller onto modelRoster() and shrink this list");
});

test("no module under src/ or scripts/ imports or defines the retired flat-cache functions", () => {
  const root = fileURLToPath(new URL("..", import.meta.url));
  const retired = /\b(readModelsCache|writeCompositeModelsCache|refreshModelsCache)\b/;
  const found = [];
  for (const sub of ["src", "scripts"]) {
    for (const path of sourceFiles(join(root, sub))) {
      if (retired.test(readFileSync(path, "utf8"))) found.push(relative(root, path).split(sep).join("/"));
    }
  }
  deepEqual(found, [], "the roster file has one reader and one writer — use modelRoster / refreshRoster");
});
