// `swarm config init` — the /swarm:swarm setup surface. Split out of
// config.test.mjs at its existing banner: everything here is about what initConfig
// WRITES into the user's file, everything there is about what loadConfig READS.
import { test } from "node:test";
import { equal, deepEqual } from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadConfig, initConfig } from "../src/config.mjs";

function tmp() {
  return mkdtempSync(join(tmpdir(), "swarm-cfg-init-"));
}

test("initConfig materialises every shipped key into the user file, keeps set values, is idempotent", () => {
  const dir = tmp();
  try {
    const p = join(dir, "home", "config.json");
    writeFileSync(join(dir, "nope"), ""); // dir exists; home/ does not — init must mkdir
    const r1 = initConfig(p);
    equal(r1.created, true);
    equal(r1.migrated, false);
    const on = JSON.parse(readFileSync(p, "utf8"));
    equal(on.providers.ollama.mode, "env");
    equal(on.dashboard.port, 7331);
    equal(on.swarm.always, false);            // shipped default now exists for swarm.always
    equal(on.disable1mContext, true);          // shipped default now exists for disable1mContext
    deepEqual(on.projects, []);                // shipped default now exists for projects
    equal(on.providers.ollama.allowedRoots, undefined); // no shipped denial — see the defaults row
    on.providers.ollama.allowedRoots = ["C:/code"];
    on.timeoutMs = 5400000;
    delete on.dashboard.livenessPollMs;       // simulate a key added by a later plugin version
    writeFileSync(p, JSON.stringify(on));
    const r2 = initConfig(p);
    equal(r2.created, false);
    equal(r2.migrated, false);
    deepEqual(r2.added, ["dashboard.livenessPollMs"]);
    const after = JSON.parse(readFileSync(p, "utf8"));
    deepEqual(after.providers.ollama.allowedRoots, ["C:/code"]);
    equal(after.timeoutMs, 5400000);
    equal(after.dashboard.livenessPollMs, 10000);
    const r3 = initConfig(p);
    deepEqual(r3.added, []);
    equal(readdirSync(join(dir, "home")).some((f) => f.endsWith(".tmp")), false, "no tmp left behind");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("initConfig rewrites a fully populated legacy file even when no default leaf is missing", () => {
  const dir = tmp();
  try {
    const p = join(dir, "config.json");
    const defaults = loadConfig(join(dir, "missing.json"));
    const legacy = JSON.parse(JSON.stringify(defaults));
    legacy.provider = legacy.providers.ollama;
    delete legacy.providers.ollama;
    writeFileSync(p, JSON.stringify(legacy));
    const result = initConfig(p);
    equal(result.migrated, true);
    const stored = JSON.parse(readFileSync(p, "utf8"));
    equal(Object.hasOwn(stored, "provider"), false);
    equal(stored.providers.ollama.mode, "env");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// The migration story the shipped-default flip rests on: `ollama.enabled` moving
// from true to false in config.default.json only touches FRESH installs, because
// initConfig's leaf fill skips a key that is already present. An operator who
// turned Ollama on by hand keeps it on. Mutating the fill to overwrite instead of
// skip makes this the only row standing between a default change and silently
// disabling a working provider on every existing machine.
test("initConfig never flips a provider the operator already enabled", () => {
  const dir = tmp();
  try {
    const p = join(dir, "config.json");
    writeFileSync(p, JSON.stringify({
      disable1mContext: true,
      providers: { ollama: { enabled: true } },
    }));
    const r = initConfig(p);
    equal(r.created, false);
    const stored = JSON.parse(readFileSync(p, "utf8"));
    equal(stored.providers.ollama.enabled, true, "a set value is kept, whatever the shipped default became");
    equal(stored.providers.codex.enabled, false, "and the absent keys are still filled from the defaults");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
