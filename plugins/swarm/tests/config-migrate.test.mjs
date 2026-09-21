import { test } from "node:test";
import { equal, deepEqual, throws } from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { initConfig, loadConfig } from "../src/config.mjs";

function tmp() {
  return mkdtempSync(join(tmpdir(), "swarm-cfgmig-"));
}

// The write boundary's own test file. config.test.mjs sits against the 500-line
// ratchet, and these rows are about what `config init` does to a file on disk
// rather than what loadConfig makes of one.

function read(p) {
  return readFileSync(p, "utf8");
}

// --- the decisive row: refuse rather than land a file the next command rejects ---

test("initConfig refuses to migrate a legacy value that would not load, and leaves the file alone", () => {
  const dir = tmp();
  try {
    const p = join(dir, "config.json");
    const before = JSON.stringify({ provider: { enabled: "yes" } });
    writeFileSync(p, before);
    throws(() => initConfig(p), /cannot migrate/);
    // Both halves. An implementation that validates after writing still throws.
    equal(read(p), before, "the file must be byte-identical — a half migration leaves the operator with neither shape");
    equal(existsSync(p + ".bak"), false, "no backup of a write that never happened");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a refused legacy migration names the legacy key the operator wrote, and the path it becomes", () => {
  const dir = tmp();
  try {
    const p = join(dir, "config.json");
    writeFileSync(p, JSON.stringify({ provider: { enabled: "yes" } }));
    throws(() => initConfig(p), (e) =>
      e.message.includes(`cannot migrate ${p}`) &&
      e.message.includes("provider.enabled must be true or false") &&
      e.message.includes("providers.ollama.enabled") &&
      e.message.includes("Nothing was written"));
    // Not hardcoded to the ollama half: the codex fold reports its own key.
    writeFileSync(p, JSON.stringify({ codex: { allowedRoots: "C:/codex" } }));
    throws(() => initConfig(p), (e) =>
      e.message.includes("codex.allowedRoots must be an array") &&
      e.message.includes("providers.codex.allowedRoots"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a bad canonical config is refused as a write, not dressed up as a migration", () => {
  const dir = tmp();
  try {
    const p = join(dir, "config.json");
    writeFileSync(p, JSON.stringify({ providers: { codex: { enabled: "yes" } } }));
    throws(() => initConfig(p), (e) =>
      e.message.includes(`cannot write ${p}`) &&
      !e.message.includes("cannot migrate") &&
      e.message.includes("providers.codex.enabled"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- the placement guard: validation runs AFTER the leaf fill ---

test("initConfig still migrates a sparse legacy object — validation runs after the leaf fill, not before", () => {
  const dir = tmp();
  try {
    const p = join(dir, "config.json");
    writeFileSync(p, JSON.stringify({ provider: {} }));
    const r = initConfig(p);
    equal(r.migrated, true);
    const stored = JSON.parse(read(p));
    equal(Object.hasOwn(stored, "provider"), false);
    equal(stored.providers.ollama.enabled, true, "the shipped default supplies the key validation needs");
    equal(loadConfig(p, process.env, { warn: () => {} }).providers.ollama.enabled, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- all five checks, one row each: the extraction must not drop the ordering ---

test("initConfig refuses every value loadConfig refuses — all five checks, one row each", () => {
  const dir = tmp();
  try {
    const p = join(dir, "config.json");
    const bad = [
      ["providers.codex.enabled", { providers: { codex: { enabled: "yes" } } }],
      ["disable1mContext", { disable1mContext: "false" }],
      ["projects", { projects: { myrepo: "cmd" } }],
      ["minFreeMemMb", { minFreeMemMb: "2048" }],
      ["valveFreeMemMb", { valveFreeMemMb: 12.5 }],
      // The easy miss: the ordering check at config.mjs. An extraction that followed a
      // remembered count of four writes this one and reports success.
      ["valveFreeMemMb", { minFreeMemMb: 512 }],
    ];
    for (const [named, input] of bad) {
      const before = JSON.stringify(input);
      writeFileSync(p, before);
      throws(() => initConfig(p), (e) => e.message.includes(named), `${named}: initConfig must refuse ${before}`);
      equal(read(p), before, `${named}: nothing written`);
      // The refusal set is loadConfig's own — same function, so they cannot drift.
      throws(() => loadConfig(p, process.env, { warn: () => {} }), (e) => e.message.includes(named), `${named}: loadConfig agrees`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- the fold is lossless for UNSHADOWED legacy leaves, and only those ---

test("migration is lossless for legacy leaves canonical does not set, and canonical wins the overlap", () => {
  const dir = tmp();
  try {
    const p = join(dir, "config.json");
    writeFileSync(p, JSON.stringify({
      provider: { url: "http://legacy", mode: "legacy-mode", launchCmd: "legacy-launch" },
      providers: { ollama: { url: "http://canonical" } },
    }));
    const r = initConfig(p);
    deepEqual(r.migratedKeys, ["provider"]);
    const stored = JSON.parse(read(p)).providers.ollama;
    // Every legacy leaf canonical does not set survives the fold. Legacy is the
    // deepMerge BASE and canonical the override, so this is the whole claim —
    // a legacy leaf canonical also sets is deliberately dropped (config.test.mjs:68).
    equal(stored.mode, "legacy-mode");
    equal(stored.launchCmd, "legacy-launch");
    equal(stored.url, "http://canonical");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- reporting ---

test("initConfig reports migratedKeys and leaves migrated a boolean", () => {
  const dir = tmp();
  try {
    const p = join(dir, "config.json");
    writeFileSync(p, JSON.stringify({ provider: { url: "http://legacy" }, codex: { enabled: true } }));
    const r = initConfig(p);
    deepEqual(r.migratedKeys, ["provider", "codex"]);
    equal(r.migrated, true, "migrated stays a boolean — three landed rows assert on it by strict equality");
    const stored = JSON.parse(read(p));
    equal(Object.hasOwn(stored, "provider"), false);
    equal(Object.hasOwn(stored, "codex"), false);
    equal(stored.providers.codex.enabled, true);
    equal(stored.providers.ollama.url, "http://legacy");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("initConfig reports no migratedKeys for an already-canonical file", () => {
  const dir = tmp();
  try {
    const p = join(dir, "config.json");
    const on = JSON.parse(read(join(fileURLToPath(new URL("../config.default.json", import.meta.url)))));
    delete on.quotaPreflight;
    writeFileSync(p, JSON.stringify(on));
    const r = initConfig(p);
    equal(r.migrated, false);
    deepEqual(r.migratedKeys, []);
    deepEqual(r.added, ["quotaPreflight"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- the backup, with its negative half ---

test("initConfig backs up the pre-migration file, and does not churn a backup without one", () => {
  const dir = tmp();
  try {
    const p = join(dir, "config.json");
    const legacy = JSON.stringify({ provider: { url: "http://legacy" } });
    writeFileSync(p, legacy);
    const r = initConfig(p);
    equal(r.migrated, true);
    // Content-identical, not byte-identical: the backup goes through writeAtomic,
    // which re-serialises — reused deliberately so a crash mid-backup cannot leave
    // a truncated .bak.
    deepEqual(JSON.parse(read(p + ".bak")), JSON.parse(legacy), "the backup is the file as it was before the fold");
    // The negative half: asserting the backup exists passes an implementation that
    // writes one on every call. A canonical file missing a shipped default fires
    // added.length, writes the file, and must leave no .bak behind.
    rmSync(p + ".bak");
    const on = JSON.parse(read(p));
    delete on.dashboard.tray;
    writeFileSync(p, JSON.stringify(on));
    const r2 = initConfig(p);
    deepEqual(r2.added, ["dashboard.tray"]);
    equal(r2.migrated, false);
    equal(existsSync(p + ".bak"), false, "the added-a-default path must not churn a backup");
    equal(readdirSync(dir).some((f) => f.endsWith(".tmp")), false, "no tmp left behind");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
