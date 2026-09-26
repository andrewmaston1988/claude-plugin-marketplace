import { test } from "node:test";
import { equal, deepEqual, ok, throws } from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync, mkdirSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { loadConfig, initConfig, deepMerge, swarmHome, DEFAULT_TIMEOUT_MS } from "../src/config.mjs";
import { loadManifest } from "./helpers/repo-io.mjs";

function tmp() {
  return mkdtempSync(join(tmpdir(), "swarm-cfg-"));
}

// The shipped file is what a fresh install gets, so it is read from DISK rather than
// from a fixture: a fixture copy of config.default.json proves nothing about what a
// new machine arrives with. Same precedent as #302, where 1,380 green fixture tests
// sat on top of a shipped config that refused every task. The values below are the
// same ones loadConfig materialises — that is the point of pinning them twice.
test("the shipped config.default.json turns on no provider until setup does", () => {
  const shipped = JSON.parse(readFileSync(fileURLToPath(new URL("../config.default.json", import.meta.url)), "utf8"));
  equal(shipped.providers.claude.enabled, false, "governance refuses a provider with no roots, so a shipped Claude-on default is not a working first run — it is a roots refusal before setup has run. The setup walk enables Claude when it sets the roots");
  equal(shipped.providers.ollama.enabled, false, "a fresh install must not arrive with Ollama already on — a work machine with no Ollama gets an enabled provider and never a question");
  equal(shipped.providers.codex.enabled, false);
});

// The engine has no `setup` subcommand: `references/setup.md` IS the wizard, so the walk
// in that file is the only thing that turns Claude on. A fresh install ships it off, and
// a walk that never writes the key leaves a machine that can dispatch nothing.
test("the setup walk enables Claude with the roots, not before them", () => {
  const doc = readFileSync(fileURLToPath(new URL("../skills/swarm/references/setup.md", import.meta.url)), "utf8");
  const stage = (from, to) => {
    const start = doc.indexOf(`### ${from}`);
    const end = doc.indexOf(`### ${to}`, start + 1);
    return doc.slice(start, end === -1 ? undefined : end);
  };
  const stage1 = stage("Stage 1 —", "Stage 1b —");
  const stage2 = stage("Stage 2 —", "Stage 3 —");

  ok(
    stage2.includes("providers.claude.enabled"),
    "Stage 2 writes the roots; Claude is enabled with them, so Stage 2 is the stage that must write providers.claude.enabled",
  );
  ok(
    !/on by default/.test(stage1),
    "no provider is on by default — Stage 1 must not tell the operator Claude is already enabled",
  );
});

test("loadConfig returns shipped defaults when user config is missing", () => {
  const dir = tmp();
  try {
    const cfg = loadConfig(join(dir, "nope.json"));
    equal(cfg.providers.claude.enabled, false);
    equal(cfg.providers.ollama.enabled, false);
    equal(cfg.providers.ollama.name, "ollama");
    equal(cfg.providers.ollama.mode, "env");
    equal(cfg.providers.ollama.url, "http://localhost:11434");
    equal(cfg.providers.ollama.authToken, "ollama");
    equal(cfg.providers.ollama.cloudSuffix, ":cloud");
    // No shipped list for either: `[]` is a deliberate denial the user never wrote, and under
    // intersection it would permanently disarm any top-level allowedRoots. Absent keeps
    // deny-by-default through the unconfigured branch instead.
    equal(cfg.providers.ollama.allowedRoots, undefined);
    equal(cfg.providers.codex.enabled, false);
    equal(cfg.providers.codex.allowedRoots, undefined);
    equal(cfg.concurrency, 4);
    equal(cfg.timeoutMs, DEFAULT_TIMEOUT_MS);
    equal(cfg.resultInlineCap, 4000);
    equal(cfg.worktreeBranchPrefix, "swarm/");
    equal(cfg.disable1mContext, true);
    deepEqual(cfg.projects, []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("legacy provider and prototype codex config normalize once into canonical providers", () => {
  const dir = tmp();
  try {
    const p = join(dir, "config.json");
    writeFileSync(p, JSON.stringify({
      provider: { allowedRoots: ["C:/ollama"], url: "http://legacy" },
      codex: { enabled: true, allowedRoots: ["C:/codex"], path: "custom-codex" },
    }));
    const warnings = [];
    const cfg = loadConfig(p, process.env, { warn: (message) => warnings.push(message) });
    deepEqual(cfg.providers.ollama.allowedRoots, ["C:/ollama"]);
    equal(cfg.providers.ollama.url, "http://legacy");
    equal(cfg.providers.codex.enabled, true);
    deepEqual(cfg.providers.codex.allowedRoots, ["C:/codex"]);
    equal(cfg.providers.codex.path, "custom-codex");
    equal(Object.hasOwn(cfg, "codex"), false);
    equal(Object.keys(cfg).includes("provider"), false);
    deepEqual(warnings, [
      "swarm config key 'provider' is deprecated; move it to 'providers.ollama'",
      "swarm config key 'codex' is deprecated; move it to 'providers.codex'",
    ]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("canonical provider keys win conflicts while legacy fills absent leaves", () => {
  const dir = tmp();
  try {
    const p = join(dir, "config.json");
    writeFileSync(p, JSON.stringify({
      provider: { allowedRoots: ["C:/legacy"], url: "http://legacy" },
      providers: { ollama: { allowedRoots: ["C:/canonical"] } },
    }));
    const cfg = loadConfig(p, process.env, { warn: () => {} });
    deepEqual(cfg.providers.ollama.allowedRoots, ["C:/canonical"]);
    equal(cfg.providers.ollama.url, "http://legacy");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("provider enabled flags and allowedRoots are validated independently", () => {
  const dir = tmp();
  try {
    const p = join(dir, "config.json");
    writeFileSync(p, JSON.stringify({ providers: { codex: { enabled: "yes" } } }));
    throws(() => loadConfig(p), /providers\.codex\.enabled/);
    writeFileSync(p, JSON.stringify({ providers: { ollama: { allowedRoots: "C:/code" } } }));
    throws(() => loadConfig(p), /providers\.ollama\.allowedRoots/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// The top-level default is the list a provider without one of its own inherits, so a
// malformed value arms or disarms the whole run's gate silently — same rule, same refusal.
test("a top-level allowedRoots is validated like the per-provider one", () => {
  const dir = tmp();
  try {
    const p = join(dir, "config.json");
    for (const bad of ["C:/code", [""], [7], {}]) {
      writeFileSync(p, JSON.stringify({ allowedRoots: bad }));
      throws(() => loadConfig(p), /allowedRoots/);
    }
    writeFileSync(p, JSON.stringify({ allowedRoots: ["C:/code"] }));
    deepEqual(loadConfig(p).allowedRoots, ["C:/code"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("malformed provider containers are rejected before defaults or migration can hide them", () => {
  const dir = tmp();
  try {
    const p = join(dir, "config.json");
    for (const bad of [{ providers: [] }, { provider: "ollama" }, { codex: true }]) {
      writeFileSync(p, JSON.stringify(bad));
      throws(() => loadConfig(p), /providers|provider|codex.*object/);
      throws(() => initConfig(p), /providers|provider|codex.*object/);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("projects must be an array: an object throws naming the key and the example", () => {
  const dir = tmp();
  try {
    const p = join(dir, "config.json");
    writeFileSync(p, JSON.stringify({ projects: { "C:/code": "cmd" } }));
    throws(() => loadConfig(p), (e) => e.message.includes("projects") && e.message.includes('"hooks": {"preToolUse": "cmd"}'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("projects entry must have a non-empty string name: throws naming the index and the field", () => {
  const dir = tmp();
  try {
    const p = join(dir, "config.json");
    writeFileSync(p, JSON.stringify({ projects: [{ hooks: { preToolUse: "cmd" } }] }));
    throws(() => loadConfig(p), (e) => e.message.includes("projects[0].name") && e.message.includes('"hooks": {"preToolUse": "cmd"}'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("projects entry hooks must be an object: throws naming the index and the field", () => {
  const dir = tmp();
  try {
    const p = join(dir, "config.json");
    writeFileSync(p, JSON.stringify({ projects: [{ name: "myrepo", hooks: "cmd" }] }));
    throws(() => loadConfig(p), (e) => e.message.includes("projects[0].hooks") && e.message.includes('"hooks": {"preToolUse": "cmd"}'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("projects entry hooks rejects an unknown key, naming preToolUse as known", () => {
  const dir = tmp();
  try {
    const p = join(dir, "config.json");
    writeFileSync(p, JSON.stringify({ projects: [{ name: "myrepo", hooks: { postToolUse: "cmd" } }] }));
    throws(() => loadConfig(p), (e) => e.message.includes("projects[0].hooks") && e.message.includes("postToolUse") && e.message.includes("preToolUse"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("projects entry hooks.preToolUse must be a string: a number throws naming the index and the field", () => {
  const dir = tmp();
  try {
    const p = join(dir, "config.json");
    writeFileSync(p, JSON.stringify({ projects: [{ name: "myrepo", hooks: { preToolUse: 1 } }] }));
    throws(() => loadConfig(p), (e) => e.message.includes("projects[0].hooks.preToolUse") && e.message.includes('"hooks": {"preToolUse": "cmd"}'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("projects rejects two entries with the same name", () => {
  const dir = tmp();
  try {
    const p = join(dir, "config.json");
    writeFileSync(p, JSON.stringify({ projects: [
      { name: "myrepo", hooks: { preToolUse: "cmd-a" } },
      { name: "myrepo", hooks: { preToolUse: "cmd-b" } },
    ] }));
    throws(() => loadConfig(p), (e) => e.message.includes("projects[1]") && e.message.includes("duplicate") && e.message.includes("myrepo"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("disable1mContext must be a boolean: a string throws naming the key and the example", () => {
  const dir = tmp();
  try {
    const p = join(dir, "config.json");
    writeFileSync(p, JSON.stringify({ disable1mContext: "false" }));
    throws(() => loadConfig(p), (e) => e.message.includes("disable1mContext") && e.message.includes('"disable1mContext": false'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("disable1mContext must be a boolean: a number throws naming the key and the example", () => {
  const dir = tmp();
  try {
    const p = join(dir, "config.json");
    writeFileSync(p, JSON.stringify({ disable1mContext: 0 }));
    throws(() => loadConfig(p), (e) => e.message.includes("disable1mContext") && e.message.includes('"disable1mContext": false'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("loadConfig returns shipped memory-floor defaults when user config is missing", () => {
  const dir = tmp();
  try {
    const cfg = loadConfig(join(dir, "nope.json"));
    equal(cfg.minFreeMemMb, 2048);
    equal(cfg.valveFreeMemMb, 1024);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("minFreeMemMb must be a non-negative integer: a string throws naming the key", () => {
  const dir = tmp();
  try {
    const p = join(dir, "config.json");
    writeFileSync(p, JSON.stringify({ minFreeMemMb: "2048" }));
    throws(() => loadConfig(p), (e) => e.message.includes("minFreeMemMb"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("minFreeMemMb must be a non-negative integer: a negative number throws naming the key", () => {
  const dir = tmp();
  try {
    const p = join(dir, "config.json");
    writeFileSync(p, JSON.stringify({ minFreeMemMb: -1 }));
    throws(() => loadConfig(p), (e) => e.message.includes("minFreeMemMb"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("valveFreeMemMb must be a non-negative integer: a non-integer throws naming the key", () => {
  const dir = tmp();
  try {
    const p = join(dir, "config.json");
    writeFileSync(p, JSON.stringify({ valveFreeMemMb: 12.5 }));
    throws(() => loadConfig(p), (e) => e.message.includes("valveFreeMemMb"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("valveFreeMemMb greater than minFreeMemMb is refused, naming both keys", () => {
  const dir = tmp();
  try {
    const p = join(dir, "config.json");
    writeFileSync(p, JSON.stringify({ minFreeMemMb: 512, valveFreeMemMb: 1024 }));
    throws(() => loadConfig(p), (e) => e.message.includes("valveFreeMemMb") && e.message.includes("minFreeMemMb"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("minFreeMemMb of 0 disables the spawn floor without throwing", () => {
  const dir = tmp();
  try {
    const p = join(dir, "config.json");
    writeFileSync(p, JSON.stringify({ minFreeMemMb: 0, valveFreeMemMb: 0 }));
    const cfg = loadConfig(p);
    equal(cfg.minFreeMemMb, 0);
    equal(cfg.valveFreeMemMb, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("minFreeMemMb of 0 (disabled floor) skips the ordering check even with a valve armed above it", () => {
  const dir = tmp();
  try {
    const p = join(dir, "config.json");
    writeFileSync(p, JSON.stringify({ minFreeMemMb: 0, valveFreeMemMb: 1024 }));
    const cfg = loadConfig(p);
    equal(cfg.minFreeMemMb, 0);
    equal(cfg.valveFreeMemMb, 1024);
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
        { id: "a", prompt: "look", provider: "claude", model: "claude-haiku-4-5-20251001", timeoutMs: 2700000 }, // per-task override
        { id: "b", prompt: "look more", provider: "claude", model: "claude-haiku-4-5-20251001" }, // no own timeout
      ],
    }));
    const cfg = { provider: { allowedRoots: [] }, providers: { claude: { enabled: true, allowedRoots: [tmpdir()] } }, concurrency: 4, timeoutMs: 50000, resultInlineCap: 4000 };
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
// config.concurrency is a CEILING, not a default: a manifest may run narrower,
// never wider. The machine that pays for the sessions sets the limit; an
// authoring model does not raise it by writing a bigger number (operator, 2026-09-05).
test("config concurrency is a ceiling: a manifest may ask for less, asking for more fails validation naming the key", () => {
  const dir = tmp();
  try {
    const p = join(dir, "plan.json");
    const cfg = { provider: { allowedRoots: [] }, providers: { claude: { enabled: true, allowedRoots: [tmpdir()] } }, concurrency: 4, timeoutMs: 50000, resultInlineCap: 4000 };
    writeFileSync(p, JSON.stringify({ concurrency: 2, tasks: [{ id: "a", prompt: "x", provider: "claude", model: "claude-haiku-4-5-20251001" }] }));
    equal(loadManifest(p, cfg, dir).concurrency, 2, "narrower is fine");
    writeFileSync(p, JSON.stringify({ tasks: [{ id: "a", prompt: "x", provider: "claude", model: "claude-haiku-4-5-20251001" }] }));
    equal(loadManifest(p, cfg, dir).concurrency, 4, "unset → the ceiling");
    writeFileSync(p, JSON.stringify({ concurrency: 8, tasks: [{ id: "a", prompt: "x", provider: "claude", model: "claude-haiku-4-5-20251001" }] }));
    throws(() => loadManifest(p, cfg, dir), (e) => /concurrency 8 exceeds the ceiling 4/.test(e.message) && /config\.json/.test(e.message));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
