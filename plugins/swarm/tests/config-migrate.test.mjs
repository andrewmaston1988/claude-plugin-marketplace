import { test } from "node:test";
import { equal, deepEqual, throws, ok } from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { initConfig, loadConfig, setConfigValue } from "../src/config.mjs";
import { runCli } from "./helpers/cli.mjs";

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

test("a bad canonical key is refused as a write even when the file also holds a legacy key", () => {
  const dir = tmp();
  try {
    const p = join(dir, "config.json");
    // The fold runs, so a head chosen from the file's own `migrated` flag would say
    // "cannot migrate" about a key the fold never touched.
    writeFileSync(p, JSON.stringify({ provider: { url: "http://legacy" }, providers: { codex: { enabled: "yes" } } }));
    throws(() => initConfig(p), (e) =>
      e.message.includes(`cannot write ${p}`) &&
      !e.message.includes("cannot migrate") &&
      e.message.includes("providers.codex.enabled must be true or false"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a canonical leaf the fold never rewrote is refused as a write, not dressed up as a migration", () => {
  const dir = tmp();
  try {
    const p = join(dir, "config.json");
    // Both halves in one file: a legacy `provider` block, and the canonical
    // providers.ollama.enabled that is the actual offender. The fold lets canonical
    // win, so `provider.enabled` is a key the fold never produced — and one the
    // operator cannot fix, because writing it changes nothing the fold does not
    // overwrite again. Naming it sends them to the wrong place.
    const before = JSON.stringify({ provider: { url: "http://legacy" }, providers: { ollama: { enabled: "yes" } } });
    writeFileSync(p, before);
    throws(() => initConfig(p), (e) =>
      e.message.includes(`cannot write ${p}`) &&
      !e.message.includes("cannot migrate") &&
      e.message.includes("providers.ollama.enabled must be true or false"));
    equal(read(p), before);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a malformed legacy value is refused with the same framing as a bad canonical one", () => {
  const dir = tmp();
  try {
    const p = join(dir, "config.json");
    // `normalizeConfigInput` throws before the leaf fill; a refusal that skips the
    // wrapper loses the path, the promise, and the re-run instruction.
    const before = JSON.stringify({ provider: "http://legacy" });
    writeFileSync(p, before);
    throws(() => initConfig(p), (e) =>
      e.message.includes(`cannot write ${p}`) &&
      e.message.includes("provider must be an object") &&
      e.message.includes("Nothing was written"));
    equal(read(p), before);
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
    // The VALUE is the shipped default (opt-in, so false); what this row needs is
    // that the fill supplied the KEY at all — a sparse legacy file sets no `enabled`
    // of its own and is only valid once the defaults supply one.
    equal(typeof stored.providers.ollama.enabled, "boolean", "the shipped default supplies the key validation needs");
    equal(loadConfig(p, process.env, { warn: () => {} }).providers.ollama.enabled, stored.providers.ollama.enabled);
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

// --- the CLI surface: the rewrite is silent on disk unless it says what it did ---

test("config init prints the mapping it applied and where the previous file went", () => {
  const dir = tmp();
  try {
    const home = join(dir, "home");
    mkdirSync(home, { recursive: true });
    const p = join(home, "config.json");
    writeFileSync(p, JSON.stringify({ provider: { url: "http://legacy" }, codex: { enabled: true } }));
    const r = runCli(["config", "init"], { cwd: dir, env: { SWARM_HOME: home, SWARM_CONFIG: p } });
    equal(r.status, 0, r.stderr);
    ok(/"provider"\s+-> "providers\.ollama"/.test(r.stdout), r.stdout);
    ok(/"codex"\s+-> "providers\.codex"/.test(r.stdout), r.stdout);
    ok(r.stdout.includes(`${p}.bak`), r.stdout);
    ok(existsSync(p + ".bak"), "the printed backup path must be the file that exists");
    // The printed mapping is a claim about the file on disk — check the file agrees.
    const stored = JSON.parse(read(p));
    equal(Object.hasOwn(stored, "provider"), false);
    equal(Object.hasOwn(stored, "codex"), false);
    equal(stored.providers.ollama.url, "http://legacy", "values are unchanged, as the report says");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- the single-key writer: the value being SET is what has to pass validation ---

test("setConfigValue refuses a value loadConfig would reject, leaving the file byte-identical", () => {
  const dir = tmp();
  try {
    const p = join(dir, "config.json");
    const before = JSON.stringify({ concurrency: 2 });
    writeFileSync(p, before);
    // Driven through the function, not the CLI: `dashboard.enabled` is the only key
    // any caller sets today, so no surface reaches this with a bad value — the guard
    // has to be asserted directly or it is never exercised at all.
    throws(() => setConfigValue("providers.ollama.enabled", "yes", p), (e) =>
      e.message.includes(`cannot write ${p}`) &&
      e.message.includes("providers.ollama.enabled must be true or false") &&
      e.message.includes("Nothing was written"));
    equal(read(p), before, "a value the next loadConfig refuses must never reach the file");
    equal(existsSync(p + ".bak"), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("setConfigValue writes a valid value, keeps every other line, and the next loadConfig accepts it", () => {
  const dir = tmp();
  try {
    const p = join(dir, "config.json");
    writeFileSync(p, JSON.stringify({ concurrency: 2 }));
    const r = setConfigValue("providers.ollama.enabled", true, p);
    equal(r.changed, true);
    equal(r.previous, undefined);
    const stored = JSON.parse(read(p));
    equal(stored.providers.ollama.enabled, true);
    equal(stored.concurrency, 2, "a verb asked to change one setting must not decide the rest");
    equal(loadConfig(p, process.env, { warn: () => {} }).providers.ollama.enabled, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("config init exits non-zero and says nothing was written when the migration is refused", () => {
  const dir = tmp();
  try {
    const home = join(dir, "home");
    mkdirSync(home, { recursive: true });
    const p = join(home, "config.json");
    const before = JSON.stringify({ provider: { enabled: "yes" } });
    writeFileSync(p, before);
    const r = runCli(["config", "init"], { cwd: dir, env: { SWARM_HOME: home, SWARM_CONFIG: p } });
    ok(r.status !== 0, `a refused migration must not report success:\n${r.stdout}`);
    ok(r.stderr.includes("cannot migrate") && r.stderr.includes("Nothing was written"), r.stderr);
    equal(read(p), before);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
