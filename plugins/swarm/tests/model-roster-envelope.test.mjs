// The roster envelope's edges: the old flat file, throttled failures, the
// reader's cost, eviction, the registry contract and the one-reader guard.

import { test } from "node:test";
import { deepEqual, equal, ok, throws, rejects } from "node:assert/strict";
import { writeFileSync, readFileSync, readdirSync, utimesSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import * as roster from "../src/roster.mjs";
import { TWELVE_H, cachePath, home, envOf, cleanup, localAdapter, networkAdapter, entryOf, namesOf } from "./helpers/roster-fixtures.mjs";
import { removeCachedModel } from "../src/discovery.mjs";
import { createProviderRegistry, createDefaultProviderRegistry, PROVIDER_CAPABILITIES } from "../src/providers.mjs";

// Named through the namespace so a missing export fails its own row rather than
// the whole file at link time.
const { modelRoster, refreshRoster, readRosterEnvelope, writeRosterEntry } = roster;

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
