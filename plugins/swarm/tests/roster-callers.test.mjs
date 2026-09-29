// Every CLI caller reads the roster through the one reader. Claude's catalog is
// the probe: it is the one roster source a raw read of the cache file cannot
// see, so a caller still reading the file passes every row here only by luck.

import { test } from "node:test";
import { deepEqual, equal, ok } from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { runCli } from "./helpers/cli.mjs";
import { readRosterEnvelope } from "../src/roster.mjs";

const CATALOG_MODEL = "claude-fable-5-1";
// Absent from the shipped Claude card: a priced name would print from the table
// alone, and the row would prove nothing about the roster behind it.
const UNPRICED_MODEL = "claude-opus-9-9";
const EFFORTS = ["low", "medium", "high"];

function tmp() {
  return mkdtempSync(join(tmpdir(), "swarm-roster-callers-"));
}

// Where the CLI child looks for it: helpers/cli.mjs pins the child's HOME to
// SWARM_HOME, so this is the only catalog it can find.
function writeCatalog(home, { fetchedAt = 500, model = CATALOG_MODEL, efforts = EFFORTS } = {}) {
  const dir = join(home, ".claude", "cache", "model-catalog");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "a-cc.json"), JSON.stringify({
    fetchedAt,
    catalog: {
      config: {
        models: [{
          id: model,
          name: model,
          thinking: { effort_options: efforts.map((id) => ({ id })) },
        }],
      },
    },
  }));
}

// Claude only: nothing is enabled by the shipped default, and Claude is the
// provider whose roster the catalog drives. The rate-card store carries a
// back-off — its own offline path — so `swarm cost` never reaches for a vendor
// page mid-test.
function world({ catalog = true, model = CATALOG_MODEL } = {}) {
  const dir = tmp();
  const home = join(dir, "home");
  mkdirSync(home, { recursive: true });
  writeFileSync(join(home, "config.json"), JSON.stringify({
    providers: { claude: { enabled: true, allowedRoots: [dir] } },
  }));
  const failedAt = new Date().toISOString();
  writeFileSync(join(home, "rate-cards.json"), JSON.stringify({
    ollama: { lastFailedAt: failedAt },
    claude: { lastFailedAt: failedAt },
  }));
  if (catalog) writeCatalog(home, { model });
  // A manifest resolves its run home against the invoking repo, so the cwd has
  // to be one — a bare temp dir is refused before any lint runs.
  spawnSync("git", ["init", "-q", "-b", "master"], { cwd: dir, windowsHide: true });
  return { dir, home };
}

const cleanup = (dir) => rmSync(dir, { recursive: true, force: true });

test("swarm models banks Claude's entry through the reader, with the catalog identity it read", () => {
  const w = world();
  try {
    const r = runCli(["models"], { cwd: w.dir, env: { SWARM_HOME: w.home } });
    equal(r.status, 0, r.stderr);
    const entry = readRosterEnvelope({ SWARM_HOME: w.home }).providers.claude;
    ok(entry, "swarm models wrote no claude entry — it is not going through the reader");
    deepEqual(entry.models.map((m) => m.model), [CATALOG_MODEL]);
    equal(entry.source, "a-cc.json@500", "the entry carries the identity of the catalog it was read from");
  } finally {
    cleanup(w.dir);
  }
});

test("swarm validate reads the roster through the reader: a catalog model's efforts bind with no models run", () => {
  const w = world();
  try {
    const p = join(w.dir, "m.json");
    writeFileSync(p, JSON.stringify({
      tasks: [{ id: "a", prompt: "x", provider: "claude", model: CATALOG_MODEL, effort: "xhigh" }],
    }));
    const r = runCli(["validate", p], { cwd: w.dir, env: { SWARM_HOME: w.home } });
    equal(r.status, 1, `the catalog's declared efforts never reached validate:\n${r.stdout}${r.stderr}`);
    ok(r.stderr.includes("effort 'xhigh'"), r.stderr);
    ok(r.stderr.includes(CATALOG_MODEL), r.stderr);

    // The same roster read still passes what the catalog does declare.
    writeFileSync(p, JSON.stringify({
      tasks: [{ id: "a", prompt: "x", provider: "claude", model: CATALOG_MODEL, effort: "high" }],
    }));
    const good = runCli(["validate", p], { cwd: w.dir, env: { SWARM_HOME: w.home } });
    equal(good.status, 0, `${good.stdout}${good.stderr}`);
  } finally {
    cleanup(w.dir);
  }
});

const OFFLINE = new URL("./helpers/offline-fetch.mjs", import.meta.url).href;

test("swarm refresh-prices reads the roster before it fetches, and reaches the vendor fetch", () => {
  const w = world();
  try {
    const r = runCli(["refresh-prices", "--dry-run"], { cwd: w.dir, env: { SWARM_HOME: w.home, NODE_OPTIONS: `--import=${OFFLINE}` } });
    ok(/-> 599/.test(r.stderr), `the command died before its first fetch:
${r.stderr}`);
  } finally {
    cleanup(w.dir);
  }
});

test("swarm cost prices a model the catalog just carried in, with no models run", () => {
  const w = world({ model: UNPRICED_MODEL });
  try {
    const r = runCli(["cost"], { cwd: w.dir, env: { SWARM_HOME: w.home } });
    equal(r.status, 0, r.stderr);
    ok(r.stdout.includes(UNPRICED_MODEL), `the catalog's model is missing from the cost list:\n${r.stdout}`);
    ok(/unpriced/.test(r.stdout.slice(r.stdout.indexOf(UNPRICED_MODEL))), "the row must be the roster's unpriced listing, not a table entry");
  } finally {
    cleanup(w.dir);
  }
});

test("swarm validate names a corrupt roster on stderr instead of reading it as empty", () => {
  const w = world();
  try {
    const p = join(w.dir, "m.json");
    writeFileSync(p, JSON.stringify({ tasks: [{ id: "a", prompt: "x", provider: "claude", model: CATALOG_MODEL }] }));
    writeFileSync(join(w.home, "models-cache.json"), "{ not json");
    const r = runCli(["validate", p], { cwd: w.dir, env: { SWARM_HOME: w.home } });
    ok(/^roster: file — .*models cache is unreadable/m.test(r.stderr), `${r.stdout}${r.stderr}`);
  } finally {
    cleanup(w.dir);
  }
});

test("swarm models prints a local provider's hydration failure as a roster line", async () => {
  const { cmdModels } = await import("../scripts/swarm.mjs");
  const { defaultProviderRegistry } = await import("../src/default-providers.mjs");
  const w = world({ catalog: false });
  const env = { ...process.env, SWARM_HOME: w.home, HOME: w.home, USERPROFILE: w.home };
  const broken = {
    id: "brokenlocal",
    runnerId: "claude",
    rosterHydration: "local",
    enabled: () => true,
    validateTask: () => [],
    capabilities: { discoverModels: () => { throw new Error("boom"); } },
  };
  try {
    const lines = [];
    const cfg = JSON.parse(readFileSync(join(w.home, "config.json"), "utf8"));
    await cmdModels([], {
      cfg, env, registry: defaultProviderRegistry({ additionalProviders: [broken] }),
      fetchImpl: async () => ({ ok: true }), write: (line) => lines.push(line),
    });
    ok(lines.includes("roster: brokenlocal — boom"), lines.join("\n"));
  } finally {
    cleanup(w.dir);
  }
});
