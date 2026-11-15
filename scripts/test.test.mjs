// Tests for the plugin test runner, its registry and its selection. Every
// interesting failure is in DERIVATION -- glob expansion, the changed set, the
// import closure -- so selection runs the real graph over fixture trees. Spawn
// and the clock are injected: a timeout costs milliseconds, a failed run nothing.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { SUITES, findSuite } from "./test-suites.mjs";
import { installIfNeeded, killTree, main, runSuites } from "./test.mjs";
import { changedSet, resolveBase } from "./test-lib/changed.mjs";
import { expandRun, select } from "./test-lib/select.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
const RUNNER = join(HERE, "test.mjs");
const WORKFLOW = join(ROOT, ".github", "workflows", "test.yml");
const FIX_GLOB = "plugins/fix/tests/*.test.mjs";
// --- Fixture plumbing ------------------------------------------------------

function git(cwd, ...args) {
  const r = spawnSync("git", args, { cwd, encoding: "utf8" });
  assert.equal(r.status, 0, `git ${args.join(" ")} failed: ${r.stderr}`);
  return r.stdout;
}

function makeRepo(t, branch = "master") {
  const dir = mkdtempSync(join(tmpdir(), "runner-"));
  t.after(() => rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));
  git(dir, "init", "-q", "-b", branch);
  git(dir, "config", "user.email", "runner@example.com");
  git(dir, "config", "user.name", "runner");
  git(dir, "config", "core.autocrlf", "false"); // stable bytes on Windows and Linux
  git(dir, "config", "commit.gpgsign", "false");
  return dir;
}

function write(cwd, rel, text = "x\n") {
  const path = join(cwd, rel);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text, "utf8");
}

function commitAll(cwd, message) {
  git(cwd, "add", "-A");
  git(cwd, "commit", "-qm", message);
}

function suiteOf(name, globs, extra = {}) {
  return { name, runs: [{ cwd: ".", globs, timeoutMs: 600000, ...extra }] };
}

/** A spawn stub: records every call, and closes (or never closes) on the next
 *  turn of the loop so the runner's listeners are attached first. */
function stubSpawn({ code = 0, never = false, pid = 4242 } = {}) {
  const calls = [];
  const spawn = (cmd, args, opts) => {
    calls.push({ cmd, args, opts });
    const listeners = { close: [], error: [] };
    const child = { pid, once: (event, cb) => (listeners[event]?.push(cb), child) };
    if (!never) setImmediate(() => listeners.close.forEach((cb) => cb(code)));
    return child;
  };
  return { spawn, calls };
}

function capture() {
  const lines = [];
  const errors = [];
  return { lines, errors, log: (line) => lines.push(line), err: (line) => errors.push(line) };
}
// --- Row 1: the registry and CI cannot drift -------------------------------

test("row 1: every registry suite is run by CI through the runner", () => {
  const yml = readFileSync(WORKFLOW, "utf8");
  for (const suite of SUITES) {
    assert.match(
      yml,
      new RegExp(`node scripts/test\\.mjs --suite ${suite.name}\\b`),
      `no CI step runs --suite ${suite.name}`,
    );
  }
});

test("row 1: every --suite CI names is a registry suite", () => {
  const yml = readFileSync(WORKFLOW, "utf8");
  // Comments talk about the runner too; only a real invocation counts.
  const body = yml.split("\n").filter((line) => !/^\s*#/.test(line)).join("\n");
  const named = new Set([...body.matchAll(/--suite\s+([a-z][a-z0-9-]*)/g)].map((match) => match[1]));
  assert.ok(named.size > 0, "test.yml carries no --suite call at all");
  for (const name of named) {
    assert.ok(findSuite(name), `CI names --suite ${name}, which the registry does not have`);
  }
});

test("row 1: every CI-only step the runner does not own is still there by name", () => {
  const yml = readFileSync(WORKFLOW, "utf8");
  const kept = [
    "500-line growth ratchet",
    "Configure git identity",
    "Plant read-only home sentinels",
    "Verify home sentinels untouched",
    "Check plugin file types",
  ];
  for (const name of kept) assert.match(yml, new RegExp(`name:\\s*${name}`), `CI lost "${name}"`);
});

test("row 1: pipeline's npm ci step is gone, because its suite's install runs it", () => {
  const yml = readFileSync(WORKFLOW, "utf8");
  assert.doesNotMatch(yml, /name:\s*Install dependencies/);
  for (const run of findSuite("pipeline").runs) {
    assert.deepEqual(run.install, ["npm", "ci"], "the install moved into the registry");
  }
});
// --- Row 3: the changed set ------------------------------------------------

test("row 3: committed, unstaged and untracked changes all enter the changed set", (t) => {
  const repo = makeRepo(t);
  write(repo, "seed.mjs");
  write(repo, ".gitignore", "ignored.txt\n");
  commitAll(repo, "seed");
  git(repo, "checkout", "-q", "-b", "feature");
  write(repo, "committed.mjs");
  commitAll(repo, "committed change");
  write(repo, "unstaged.mjs");
  write(repo, "untracked.mjs");
  write(repo, "ignored.txt");

  const changed = changedSet({ repoRoot: repo, base: resolveBase({ repoRoot: repo }) });
  for (const path of ["committed.mjs", "unstaged.mjs", "untracked.mjs"]) {
    assert.ok(changed.includes(path), `${path} missing from ${changed.join(",")}`);
  }
  assert.ok(!changed.includes("ignored.txt"), "an ignored file is not a change");
});

test("row 3: master is the base when there is no origin, and the merge-base is used", (t) => {
  const repo = makeRepo(t);
  write(repo, "seed.mjs");
  commitAll(repo, "seed");
  git(repo, "checkout", "-q", "-b", "feature");
  write(repo, "work.mjs");
  commitAll(repo, "feature work");
  // master moves on: its own commit must not read as this branch's change.
  git(repo, "checkout", "-q", "master");
  write(repo, "elsewhere.mjs");
  commitAll(repo, "master moves");
  git(repo, "checkout", "-q", "feature");

  const changed = changedSet({ repoRoot: repo, base: resolveBase({ repoRoot: repo }) });
  assert.ok(changed.includes("work.mjs"), changed.join(","));
  assert.ok(!changed.includes("elsewhere.mjs"), "master's own commit is not this branch's diff");
});

test("row 3: no master and no --against exits 2 naming --against", (t) => {
  const repo = makeRepo(t, "trunk");
  write(repo, "seed.mjs");
  commitAll(repo, "seed");

  const r = spawnSync(process.execPath, [RUNNER, "--list"], { cwd: repo, encoding: "utf8" });
  assert.equal(r.status, 2, r.stdout + r.stderr);
  assert.match(r.stderr, /--against/);
});

test("row 3: --against overrides the branch base and an unknown ref fails closed", (t) => {
  const repo = makeRepo(t);
  write(repo, "seed.mjs");
  commitAll(repo, "seed");
  const base = git(repo, "rev-parse", "HEAD").trim();

  assert.equal(resolveBase({ repoRoot: repo, against: base }), base);
  assert.throws(() => resolveBase({ repoRoot: repo, against: "no-such-ref" }), /not a ref/);
});
// --- Rows 4, 5, 6: the import graph and its fallbacks ----------------------

/** The fixture plugin: one module chain, one dynamic import, one URL file, one
 *  URL directory, two computed `join()` paths -- and a `.win.test.mjs`. */
function graphFixture(t) {
  const repo = makeRepo(t);
  const files = {
    "plugins/fix/src/a.mjs": "export const a = 1;\n",
    "plugins/fix/src/b.mjs": 'import { a } from "./a.mjs";\nexport const b = a;\n',
    "plugins/fix/tests/transitive.test.mjs": 'import { b } from "../src/b.mjs";\n',
    "plugins/fix/tests/unrelated.test.mjs": "export const nothing = 1;\n",
    "plugins/fix/src/dyn.mjs": "export const dyn = 1;\n",
    "plugins/fix/tests/dynamic.test.mjs": 'await import("../src/dyn.mjs");\n',
    "plugins/fix/bin/urlonly.mjs": "export const cli = 1;\n",
    "plugins/fix/tests/url-file.test.mjs":
      'const p = new URL("../bin/urlonly.mjs", import.meta.url).pathname;\n',
    "plugins/fix/templates/a.md": "template\n",
    "plugins/fix/tests/url-dir.test.mjs": 'const d = new URL("../templates", import.meta.url);\n',
    "plugins/fix/bin/joined.mjs": "export const joined = 1;\n",
    "plugins/fix/tests/join-cli.test.mjs": 'join(here, "..", "bin", "joined.mjs");\n',
    "plugins/fix/skills/x/SKILL.md": "skill\n",
    "plugins/fix/tests/join-skill.test.mjs": 'join(SKILLS, "skills/x/SKILL.md");\n',
    "plugins/fix/package.json": "{}\n",
    "plugins/fix/package-lock.json": "{}\n",
    "plugins/fix/hooks/hooks.json": "{}\n",
    "plugins/fix/.claude-plugin/plugin.json": "{}\n",
    "plugins/fix/.codex-plugin/plugin.json": "{}\n",
    "plugins/fix/.env.test": "A=1\n",
    "plugins/fix/notes.md": "notes\n",
    // Names the fallback files from inside a closure: without the fallback
    // rule only this one test would be selected, not the whole suite.
    "plugins/fix/tests/manifest.test.mjs":
      'for (const p of ["../package.json", "../package-lock.json", "../hooks/hooks.json",\n  "../.claude-plugin/plugin.json", "../.codex-plugin/plugin.json", "../.env.test"]) new URL(p, import.meta.url);\n',
    "plugins/fix/src/tray/windows.ps1": "# tray\n",
    "plugins/fix/tests/thing.win.test.mjs": "export const w = 1;\n",
    "scripts/keep.test.mjs": "export const k = 1;\n",
  };
  for (const [rel, text] of Object.entries(files)) write(repo, rel, text);
  return repo;
}

const fixEntries = (repo, changed) =>
  select({ suites: [suiteOf("fix", [FIX_GLOB])], changed, repoRoot: repo }).entries;

const selectedFile = (entries, suffix) => entries.filter((entry) => entry.file.endsWith(suffix));

test("row 4: a change reaches a test through a transitive import and no further", (t) => {
  const entries = fixEntries(graphFixture(t), ["plugins/fix/src/a.mjs"]);
  const reached = selectedFile(entries, "transitive.test.mjs");
  assert.equal(reached.length, 1, JSON.stringify(entries));
  assert.equal(reached[0].why, "changed: plugins/fix/src/a.mjs");
  assert.deepEqual(selectedFile(entries, "unrelated.test.mjs"), [], "a test importing neither was selected");
});

test("row 5: a string-literal import() enters the closure", (t) => {
  const entries = fixEntries(graphFixture(t), ["plugins/fix/src/dyn.mjs"]);
  assert.equal(selectedFile(entries, "dynamic.test.mjs").length, 1, JSON.stringify(entries));
});

test("row 5: a new URL literal naming a file enters the closure", (t) => {
  const entries = fixEntries(graphFixture(t), ["plugins/fix/bin/urlonly.mjs"]);
  assert.equal(selectedFile(entries, "url-file.test.mjs").length, 1, JSON.stringify(entries));
});

test("row 5: a new URL literal naming a directory adds every file under it", (t) => {
  const entries = fixEntries(graphFixture(t), ["plugins/fix/templates/a.md"]);
  assert.equal(selectedFile(entries, "url-dir.test.mjs").length, 1, JSON.stringify(entries));
});

test("row 5: a computed join() path is caught by its basename literal", (t) => {
  const repo = graphFixture(t);
  const cli = fixEntries(repo, ["plugins/fix/bin/joined.mjs"]);
  assert.equal(selectedFile(cli, "join-cli.test.mjs").length, 1, JSON.stringify(cli));
  const skill = fixEntries(repo, ["plugins/fix/skills/x/SKILL.md"]);
  assert.equal(selectedFile(skill, "join-skill.test.mjs").length, 1, JSON.stringify(skill));
});

test("row 6: a changed .md in no closure selects nothing and reports docs-only", (t) => {
  const result = select({ suites: [suiteOf("fix", [FIX_GLOB])], changed: ["plugins/fix/notes.md"], repoRoot: graphFixture(t) });
  assert.deepEqual(result.entries.filter((entry) => entry.why !== "windows"), []);
  assert.equal(result.docsOnly, true);
});

test("row 6: a changed non-.md file in no closure runs the whole suite", (t) => {
  const path = "plugins/fix/src/tray/windows.ps1";
  const entries = fixEntries(graphFixture(t), [path]);
  assert.ok(entries.length >= 6, JSON.stringify(entries));
  assert.ok(entries.every((entry) => entry.why === `fallback: ${path}`));
});

test("row 6: --list reports the change docs-only through the real CLI", async (t) => {
  const repo = graphFixture(t);
  commitAll(repo, "fixture");
  write(repo, "plugins/fix/extra.md", "more notes\n");
  const out = capture();
  const code = await main(["--list"], {
    cwd: repo,
    _suites: [suiteOf("fix", [FIX_GLOB])],
    _log: out.log,
    _err: out.err,
  });
  assert.equal(code, 0);
  assert.match(out.errors.join("\n"), /docs-only/);
  const rows = out.lines.map((line) => line.split(" ").slice(0, 2).join(" "));
  assert.deepEqual(rows, ["fix plugins/fix/tests/thing.win.test.mjs"], ".md selects nothing");
});
// --- Row 7: whole-suite fallbacks -----------------------------------------

test("row 7: lockfiles and plugin manifests run the whole suite", (t) => {
  const repo = graphFixture(t);
  const suite = [suiteOf("fix", [FIX_GLOB])];
  const all = expandRun(suite[0].runs[0], { repoRoot: repo }).length;
  const fallbacks = [
    "plugins/fix/package.json",
    "plugins/fix/package-lock.json",
    "plugins/fix/.claude-plugin/plugin.json",
    "plugins/fix/.codex-plugin/plugin.json",
    "plugins/fix/hooks/hooks.json",
    "plugins/fix/.env.test",
  ];
  for (const path of fallbacks) {
    const { entries } = select({ suites: suite, changed: [path], repoRoot: repo });
    assert.equal(entries.length, all, `${path} should run the whole suite`);
    assert.ok(entries.every((entry) => entry.why === `fallback: ${path}`), path);
  }
});

test("row 7: a change under scripts/ or .github/ runs the repo suite", (t) => {
  const repo = graphFixture(t);
  const suites = [suiteOf("fix", [FIX_GLOB]), suiteOf("repo", ["scripts/*.test.mjs"])];
  for (const path of ["scripts/x.mjs", ".github/workflows/test.yml"]) {
    const { entries } = select({ suites, changed: [path], repoRoot: repo });
    const repoEntries = entries.filter((entry) => entry.suite === "repo");
    assert.equal(repoEntries.length, 1, path);
    assert.equal(repoEntries[0].why, `fallback: ${path}`);
    const attributed = entries.filter((entry) => entry.suite === "fix" && entry.why !== "windows");
    assert.deepEqual(attributed, [], "a repo-level change must not select a plugin test");
  }
});
// --- Row 8: every .win.test.mjs always runs -------------------------------

test("row 8: a .win.test.mjs is selected by a diff that touches none of it", (t) => {
  const entries = fixEntries(graphFixture(t), ["plugins/fix/notes.md"]);
  const win = selectedFile(entries, ".win.test.mjs");
  assert.equal(win.length, 1, JSON.stringify(entries));
  assert.equal(win[0].why, "windows");
});
// --- Row 9: --list runs nothing -------------------------------------------

test("row 9: --list prints <suite> <file> <why> and spawns no node --test", async (t) => {
  const repo = graphFixture(t);
  commitAll(repo, "fixture");
  write(repo, "plugins/fix/src/a.mjs", "export const a = 2;\n");
  const spawn = stubSpawn();
  const out = capture();
  const code = await main(["--list"], {
    cwd: repo,
    _suites: [suiteOf("fix", [FIX_GLOB])],
    _spawn: spawn.spawn,
    _log: out.log,
    _err: out.err,
  });
  assert.equal(code, 0);
  assert.equal(spawn.calls.length, 0, "list mode spawned a process");
  assert.ok(out.lines.length > 0);
  for (const line of out.lines) {
    const [, suite, file, why] = /^(\S+) (\S+) (.*)$/.exec(line);
    assert.equal(suite, "fix", line);
    assert.match(file, /^plugins\/fix\/tests\//);
    assert.match(why, /^(changed: |windows$|fallback: )/, line);
  }
});
// --- Row 16: globs ---------------------------------------------------------

test("row 16: ** matches zero or more directories, * matches one level", (t) => {
  const repo = makeRepo(t);
  write(repo, "tests/a.test.mjs");
  write(repo, "tests/deep/b.test.mjs");
  write(repo, "tests/deep/deeper/c.test.mjs");

  const deep = expandRun({ cwd: ".", globs: ["tests/**/*.test.mjs"] }, { repoRoot: repo });
  assert.deepEqual(deep, ["tests/a.test.mjs", "tests/deep/b.test.mjs", "tests/deep/deeper/c.test.mjs"]);
  const flat = expandRun({ cwd: ".", globs: ["tests/*.test.mjs"] }, { repoRoot: repo });
  assert.deepEqual(flat, ["tests/a.test.mjs"]);
});

test("row 16: a run whose globs match nothing fails, names the glob, and spawns nothing", async (t) => {
  const repo = makeRepo(t);
  write(repo, "tests/a.test.mjs");
  const spawn = stubSpawn();
  const results = await runSuites([suiteOf("empty", ["nowhere/*.test.mjs"])], {
    repoRoot: repo,
    _spawn: spawn.spawn,
  });
  assert.equal(results.length, 1);
  assert.equal(results[0].status, "no-files");
  assert.match(results[0].reason, /nowhere\/\*\.test\.mjs/);
  assert.equal(spawn.calls.length, 0, "an empty expansion spawned node --test bare");
});
// --- Row 10: failure exit codes -------------------------------------------

test("row 10: a failing run exits 1 and the summary names it; all green exits 0", async (t) => {
  const repo = graphFixture(t);
  const run = (spawn) =>
    main(["--suite", "fix"], {
      cwd: repo,
      _suites: [suiteOf("fix", [FIX_GLOB])],
      _spawn: spawn.spawn,
      _log: (line) => lines.push(line),
      _err: () => {},
    });
  const lines = [];

  const failing = stubSpawn({ code: 1 });
  assert.equal(await run(failing), 1);
  assert.ok(failing.calls.length > 0, "nothing was spawned at all");
  assert.match(lines.join("\n"), /\[test\] fix: FAIL/);
  assert.match(lines.join("\n"), /0\/1 run\(s\) passed/);

  assert.equal(await run(stubSpawn({ code: 0 })), 0);
  assert.match(lines.join("\n"), /1\/1 run\(s\) passed/);
});

test("a run spawns node with the tests in the run's cwd and its env", async (t) => {
  const repo = graphFixture(t);
  const spawn = stubSpawn();
  await runSuites([suiteOf("fix", [FIX_GLOB], { env: { A: "1" } })], {
    repoRoot: repo,
    _spawn: spawn.spawn,
  });
  const call = spawn.calls[0];
  assert.equal(call.args[0], "--test", "the file list must follow --test");
  assert.ok(call.args.includes("plugins/fix/tests/transitive.test.mjs"), call.args.join(" "));
  assert.equal(call.opts.cwd, repo);
  assert.equal(call.opts.env.A, "1");
});
// --- Row 17: timeout kills the tree ---------------------------------------

test("row 17: killTree uses taskkill /T on win32 and the process group elsewhere", () => {
  const spawned = [];
  killTree(99, { platform: "win32", _spawnSync: (...args) => spawned.push(args) });
  assert.deepEqual(spawned[0], ["taskkill", ["/T", "/F", "/PID", "99"], { stdio: "ignore" }]);

  const killed = [];
  killTree(99, { platform: "linux", _kill: (pid, signal) => killed.push([pid, signal]) });
  assert.deepEqual(killed, [[-99, "SIGKILL"]]);
});

test("row 17: a run past its timeout is killed and reported failed", async (t) => {
  const repo = graphFixture(t);
  const suite = suiteOf("slow", [FIX_GLOB]);
  suite.runs[0].timeoutMs = 30;
  const killed = [];
  const lines = [];
  const code = await main(["--suite", "slow"], {
    cwd: repo,
    _suites: [suite],
    _spawn: stubSpawn({ never: true, pid: 777 }).spawn,
    _killTree: (pid) => killed.push(pid),
    _log: (line) => lines.push(line),
    _err: () => {},
  });
  assert.equal(code, 1, "a timed-out run must fail the runner");
  assert.deepEqual(killed, [777], "the run's tree was not killed");
  assert.match(lines.join("\n"), /TIMEOUT/);
});
// --- Row 18: hash-gated install -------------------------------------------

function memoryFs(files) {
  return {
    existsSync: (path) => files.has(path),
    readFileSync: (path) => {
      if (!files.has(path)) throw new Error(`ENOENT ${path}`);
      return files.get(path);
    },
    writeFileSync: (path, value) => files.set(path, value),
    mkdirSync: () => {},
  };
}

test("row 18: install runs when the hash is missing or differs, and is skipped when it matches", () => {
  const cwd = join(tmpdir(), "install-fixture");
  const lockfile = join(cwd, "package-lock.json");
  const record = join(cwd, "node_modules", ".test-install-hash");
  const files = new Map([[lockfile, '{"lockfileVersion":3}']]);
  const calls = [];
  const options = {
    cwd,
    install: ["npm", "ci"],
    _fs: memoryFs(files),
    _spawnSync: (...args) => {
      calls.push(args);
      return { status: 0 };
    },
    _platform: "linux",
  };

  assert.equal(installIfNeeded(options).installed, true);
  assert.deepEqual(calls[0].slice(0, 2), ["npm", ["ci"]]);
  assert.ok(files.has(record), "the hash was not recorded");

  assert.equal(installIfNeeded(options).installed, false);
  assert.equal(calls.length, 1, "a matching hash still reinstalled");

  files.set(lockfile, '{"lockfileVersion":3,"changed":true}');
  assert.equal(installIfNeeded(options).installed, true);
  assert.equal(calls.length, 2);

  files.set(lockfile, "different again");
  assert.match(installIfNeeded({ ...options, _spawnSync: () => ({ status: 1 }) }).error, /install failed/);

  // A suite with no lockfile has nothing to hash, so it installs nothing.
  const bare = [];
  const none = installIfNeeded({
    cwd: join(tmpdir(), "no-lockfile"),
    install: ["npm", "ci"],
    _fs: memoryFs(new Map()),
    _spawnSync: (...args) => bare.push(args),
  });
  assert.equal(none.installed, false);
  assert.equal(bare.length, 0);
});
