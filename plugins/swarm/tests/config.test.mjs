import { test } from "node:test";
import { equal, deepEqual, throws, ok } from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync, mkdirSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { loadConfig, deepMerge, swarmHome, DEFAULT_TIMEOUT_MS } from "../src/config.mjs";
import { loadManifest } from "./helpers/repo-io.mjs";
import { buildDispatch, toSpawnable, windowsCommandLineLength } from "../src/dispatch.mjs";

function tmp() {
  return mkdtempSync(join(tmpdir(), "swarm-cfg-"));
}

test("loadConfig returns shipped defaults when user config is missing", () => {
  const dir = tmp();
  try {
    const cfg = loadConfig(join(dir, "nope.json"));
    equal(cfg.providers.claude.enabled, true);
    equal(cfg.providers.ollama.enabled, true);
    equal(cfg.providers.ollama.name, "ollama");
    equal(cfg.providers.ollama.mode, "env");
    equal(cfg.providers.ollama.url, "http://localhost:11434");
    equal(cfg.providers.ollama.authToken, "ollama");
    equal(cfg.providers.ollama.cloudSuffix, ":cloud");
    deepEqual(cfg.providers.ollama.allowedRoots, []);
    equal(cfg.providers.codex.enabled, false);
    deepEqual(cfg.providers.codex.allowedRoots, []);
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
// ---- config init / explain / set (the /swarm:swarm setup surface) ----
import { initConfig } from "../src/config.mjs";

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
    deepEqual(on.providers.ollama.allowedRoots, []);
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



// config.concurrency is a CEILING, not a default: a manifest may run narrower,
// never wider. The machine that pays for the sessions sets the limit; an
// authoring model does not raise it by writing a bigger number (operator, 2026-09-05).
test("config concurrency is a ceiling: a manifest may ask for less, asking for more fails validation naming the key", () => {
  const dir = tmp();
  try {
    const p = join(dir, "plan.json");
    const cfg = { provider: { allowedRoots: [] }, concurrency: 4, timeoutMs: 50000, resultInlineCap: 4000 };
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

// ── win32 command-line-length check (swarm-long-prompts) ──────────────────────
// A leaf's prompt is passed as a command-line argument (dispatch.mjs's
// buildDispatch: "-p", prompt). Windows caps a whole command line at 32,767
// characters — a leaf over that can never spawn (ENAMETOOLONG). validate
// catches it before anything spends.

test("win32 command-line check: a 40,000-char prompt fails, naming the task, its length and the file-pointer fix", () => {
  const dir = tmp();
  try {
    const p = join(dir, "plan.json");
    const cfg = { provider: { allowedRoots: [] }, concurrency: 4, timeoutMs: 50000, resultInlineCap: 4000, claudePath: "C:\\fake\\claude.exe" };
    writeFileSync(p, JSON.stringify({ tasks: [{ id: "long", prompt: "x".repeat(40000), provider: "claude", model: "claude-haiku-4-5-20251001" }] }));
    throws(
      () => loadManifest(p, cfg, dir, { io: { platform: "win32" } }),
      (e) => /task 'long'/.test(e.message) && /command line/.test(e.message) &&
        /\d{5}/.test(e.message) && /point the leaf at a file/.test(e.message)
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("win32 command-line check: the same manifest loads fine on linux (platform injected)", () => {
  const dir = tmp();
  try {
    const p = join(dir, "plan.json");
    const cfg = { provider: { allowedRoots: [] }, concurrency: 4, timeoutMs: 50000, resultInlineCap: 4000, claudePath: "C:\\fake\\claude.exe" };
    writeFileSync(p, JSON.stringify({ tasks: [{ id: "long", prompt: "x".repeat(40000), provider: "claude", model: "claude-haiku-4-5-20251001" }] }));
    const plan = loadManifest(p, cfg, dir, { io: { platform: "linux" } });
    equal(plan.tasks[0].id, "long");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("win32 command-line check: a 31,000-char prompt plus a long allowedTools list together exceed the cap", () => {
  const dir = tmp();
  try {
    const p = join(dir, "plan.json");
    const cfg = { provider: { allowedRoots: [] }, concurrency: 4, timeoutMs: 50000, resultInlineCap: 4000, claudePath: "C:\\fake\\claude.exe" };
    const bigTools = Array.from({ length: 200 }, (_, i) => `Tool${i}`).join(",");
    writeFileSync(p, JSON.stringify({
      tasks: [{ id: "combo", prompt: "x".repeat(31000), provider: "claude", model: "claude-haiku-4-5-20251001", allowedTools: bigTools }],
    }));
    throws(
      () => loadManifest(p, cfg, dir, { io: { platform: "win32" } }),
      (e) => /task 'combo'/.test(e.message) && /command line/.test(e.message)
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("win32 command-line check: a {{result:x}} placeholder is measured at resultInlineCap characters, not its raw template text", () => {
  const dir = tmp();
  try {
    const p = join(dir, "plan.json");
    const cfg = { provider: { allowedRoots: [] }, concurrency: 4, timeoutMs: 50000, resultInlineCap: 40000, claudePath: "C:\\fake\\claude.exe" };
    writeFileSync(p, JSON.stringify({
      tasks: [
        { id: "a", prompt: "look", provider: "claude", model: "claude-haiku-4-5-20251001" },
        { id: "b", prompt: "use {{result:a}}", provider: "claude", model: "claude-haiku-4-5-20251001", after: ["a"] },
      ],
    }));
    throws(
      () => loadManifest(p, cfg, dir, { io: { platform: "win32" } }),
      (e) => /task 'b'/.test(e.message) && /command line/.test(e.message)
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("win32 command-line check: a 20,000-char prompt of quote characters fails (quoting doubles it past the cap)", () => {
  const dir = tmp();
  try {
    const p = join(dir, "plan.json");
    const cfg = { provider: { allowedRoots: [] }, concurrency: 4, timeoutMs: 50000, resultInlineCap: 4000, claudePath: "C:\\fake\\claude.exe" };
    writeFileSync(p, JSON.stringify({ tasks: [{ id: "quotey", prompt: '"'.repeat(20000), provider: "claude", model: "claude-haiku-4-5-20251001" }] }));
    throws(
      () => loadManifest(p, cfg, dir, { io: { platform: "win32" } }),
      (e) => /task 'quotey'/.test(e.message) && /command line/.test(e.message)
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("win32 command-line check: with a .cmd launcher, the measured length includes the cmd /d /s /c wrapper", () => {
  const dir = tmp();
  try {
    const cmdPath = join(dir, "claude.cmd");
    writeFileSync(cmdPath, "@echo off\r\necho hello\r\n"); // opaque shim -> cmd /d /s /c fallback
    const cfg = { provider: { allowedRoots: [] }, concurrency: 4, timeoutMs: 50000, resultInlineCap: 4000, claudePath: cmdPath };
    const baseTask = { id: "shim", provider: "claude", model: "claude-haiku-4-5-20251001", allowedTools: "Read,Grep,Glob" };
    // Find the prompt length where the WRAPPED command line just crosses the
    // cap but the bare (unwrapped) argv join would not — isolates that the
    // wrapper itself is what's being counted.
    let promptLen = 31000;
    let found = false;
    for (; promptLen < 32500; promptLen++) {
      const prompt = "x".repeat(promptLen);
      const { argv } = buildDispatch(baseTask, prompt, cfg);
      const bare = windowsCommandLineLength(argv);
      const { cmd, args } = toSpawnable(argv, { _platform: "win32" });
      const wrapped = windowsCommandLineLength([cmd, ...args]);
      if (bare <= 32000 && wrapped > 32000) { found = true; break; }
    }
    ok(found, "expected a prompt length where wrapping crosses the cap but the bare join doesn't");
    const p = join(dir, "plan.json");
    writeFileSync(p, JSON.stringify({
      tasks: [{ ...baseTask, prompt: "x".repeat(promptLen) }],
    }));
    throws(
      () => loadManifest(p, cfg, dir, { io: { platform: "win32" } }),
      (e) => /task 'shim'/.test(e.message) && /command line/.test(e.message)
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
