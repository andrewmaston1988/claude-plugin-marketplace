// Tests for the plugin test runner, its registry and its selection. Failures are
// in DERIVATION -- glob expansion, the changed set, the import closure -- so
// selection runs the real graph over fixtures, with spawn and clock injected.

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
import { recordTimings } from "./test-lib/fast.mjs";
import { expandRun, select } from "./test-lib/select.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
const RUNNER = join(HERE, "test.mjs");
const WORKFLOW = join(ROOT, ".github", "workflows", "test.yml");
const FIX_GLOB = "plugins/fix/tests/*.test.mjs";

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

test("every registry suite is run by CI through the runner", () => {
  const yml = readFileSync(WORKFLOW, "utf8");
  for (const suite of SUITES) {
    assert.match(
      yml,
      new RegExp(`node scripts/test\\.mjs --suite ${suite.name}\\b`),
      `no CI step runs --suite ${suite.name}`,
    );
  }
});

test("every --suite CI names is a registry suite", () => {
  const yml = readFileSync(WORKFLOW, "utf8");
  // Comments talk about the runner too; only a real invocation counts.
  const body = yml.split("\n").filter((line) => !/^\s*#/.test(line)).join("\n");
  const named = new Set([...body.matchAll(/--suite\s+([a-z][a-z0-9-]*)/g)].map((match) => match[1]));
  assert.ok(named.size > 0, "test.yml carries no --suite call at all");
  for (const name of named) {
    assert.ok(findSuite(name), `CI names --suite ${name}, which the registry does not have`);
  }
});

test("every CI suite job selects itself from the diff and has its base history", () => {
  const yml = readFileSync(WORKFLOW, "utf8");
  const blocks = yml.split(/^  [a-z-]+:$/m).filter((block) => /run: node scripts\/test\.mjs --suite/.test(block));
  assert.equal(blocks.length, SUITES.length, "a suite job is missing from the workflow");
  for (const block of blocks) {
    assert.match(block, /--if-selected --against/, "a suite job runs whatever the diff touches");
    assert.match(block, /fetch-depth: 0/, "a suite job cannot see its diff base in a shallow clone");
  }
  assert.match(yml, /run: node scripts\/test\.mjs --orphans/, "the always-running job checks no orphans");
});

test("every CI-only step the runner does not own is still there by name", () => {
  const yml = readFileSync(WORKFLOW, "utf8");
  const kept = ["500-line growth ratchet", "Configure git identity", "Plant read-only home sentinels",
    "Verify home sentinels untouched", "Check plugin file types"];
  for (const name of kept) assert.match(yml, new RegExp(`name:\\s*${name}`), `CI lost "${name}"`);
});

test("pipeline's npm ci step is gone, because its suite's install runs it", () => {
  const yml = readFileSync(WORKFLOW, "utf8");
  assert.doesNotMatch(yml, /name:\s*Install dependencies/);
  for (const run of findSuite("pipeline").runs) {
    assert.deepEqual(run.install, ["npm", "ci"], "the install moved into the registry");
  }
});

test("committed, unstaged and untracked changes all enter the changed set", (t) => {
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

test("master is the base when there is no origin, and the merge-base is used", (t) => {
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

test("no master and no --against exits 2 naming --against", (t) => {
  const repo = makeRepo(t, "trunk");
  write(repo, "seed.mjs");
  commitAll(repo, "seed");

  const r = spawnSync(process.execPath, [RUNNER, "--list"], { cwd: repo, encoding: "utf8" });
  assert.equal(r.status, 2, r.stdout + r.stderr);
  assert.match(r.stderr, /--against/);
});

test("--against overrides the branch base and an unknown ref fails closed", (t) => {
  const repo = makeRepo(t);
  write(repo, "seed.mjs");
  commitAll(repo, "seed");
  const base = git(repo, "rev-parse", "HEAD").trim();

  assert.equal(resolveBase({ repoRoot: repo, against: base }), base);
  assert.throws(() => resolveBase({ repoRoot: repo, against: "no-such-ref" }), /not a ref/);
});

/** The fixture plugin: one module chain, one dynamic import, one URL file, one
 *  URL directory, a computed plugin-root locator, two computed `join()` paths
 *  -- and a `.win.test.mjs`. */
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
    "plugins/fix/src/root.mjs": 'export const root = new URL("..", import.meta.url);\nexport const here = new URL(".", import.meta.url);\n',
    "plugins/fix/tests/root.test.mjs": 'import { root } from "../src/root.mjs";\n',
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

test("a change reaches a test through a transitive import and no further", (t) => {
  const entries = fixEntries(graphFixture(t), ["plugins/fix/src/a.mjs"]);
  const reached = selectedFile(entries, "transitive.test.mjs");
  assert.equal(reached.length, 1, JSON.stringify(entries));
  assert.equal(reached[0].why, "changed: plugins/fix/src/a.mjs");
  assert.deepEqual(selectedFile(entries, "unrelated.test.mjs"), [], "a test importing neither was selected");
});

test("a string-literal import() enters the closure", (t) => {
  const entries = fixEntries(graphFixture(t), ["plugins/fix/src/dyn.mjs"]);
  assert.equal(selectedFile(entries, "dynamic.test.mjs").length, 1, JSON.stringify(entries));
});

test("a new URL literal naming a file enters the closure", (t) => {
  const entries = fixEntries(graphFixture(t), ["plugins/fix/bin/urlonly.mjs"]);
  assert.equal(selectedFile(entries, "url-file.test.mjs").length, 1, JSON.stringify(entries));
});

test("a new URL literal naming a directory adds every file under it", (t) => {
  const entries = fixEntries(graphFixture(t), ["plugins/fix/templates/a.md"]);
  assert.equal(selectedFile(entries, "url-dir.test.mjs").length, 1, JSON.stringify(entries));
});

test("a URL locator ending in . or .. enumerates no directory contents", (t) => {
  const result = select({ suites: [suiteOf("fix", [FIX_GLOB])], changed: ["plugins/fix/notes.md"], repoRoot: graphFixture(t) });
  assert.deepEqual(result.entries.filter((entry) => entry.why !== "windows"), [], "a plugin-root locator walked the plugin");
  assert.equal(result.docsOnly, true);
});

test("a computed join() path is caught by its basename literal", (t) => {
  const repo = graphFixture(t);
  const cli = fixEntries(repo, ["plugins/fix/bin/joined.mjs"]);
  assert.equal(selectedFile(cli, "join-cli.test.mjs").length, 1, JSON.stringify(cli));
  const skill = fixEntries(repo, ["plugins/fix/skills/x/SKILL.md"]);
  assert.equal(selectedFile(skill, "join-skill.test.mjs").length, 1, JSON.stringify(skill));
});

test("a changed .md in no closure selects nothing and reports docs-only", (t) => {
  const result = select({ suites: [suiteOf("fix", [FIX_GLOB])], changed: ["plugins/fix/notes.md"], repoRoot: graphFixture(t) });
  assert.deepEqual(result.entries.filter((entry) => entry.why !== "windows"), [], "a .md in no closure selected a test");
  assert.equal(result.docsOnly, true);
});

test("a changed non-.md file in no closure runs the whole suite", (t) => {
  const path = "plugins/fix/src/tray/windows.ps1";
  const entries = fixEntries(graphFixture(t), [path]);
  assert.ok(entries.length >= 6, JSON.stringify(entries));
  assert.ok(entries.every((entry) => entry.why === `fallback: ${path}`));
});

test("--list reports the change docs-only through the real CLI", async (t) => {
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

test("lockfiles and plugin manifests run the whole suite", (t) => {
  const repo = graphFixture(t);
  const suite = [suiteOf("fix", [FIX_GLOB])];
  const all = expandRun(suite[0].runs[0], { repoRoot: repo }).length;
  const fallbacks = ["plugins/fix/package.json", "plugins/fix/package-lock.json",
    "plugins/fix/.claude-plugin/plugin.json", "plugins/fix/.codex-plugin/plugin.json",
    "plugins/fix/hooks/hooks.json", "plugins/fix/.env.test"];
  for (const path of fallbacks) {
    const { entries } = select({ suites: suite, changed: [path], repoRoot: repo });
    assert.equal(entries.length, all, `${path} should run the whole suite`);
    assert.ok(entries.every((entry) => entry.why === `fallback: ${path}`), path);
  }
});

test("a change under scripts/ runs the repo suite, not a plugin's", (t) => {
  const repo = graphFixture(t);
  const suites = [suiteOf("fix", [FIX_GLOB]), suiteOf("repo", ["scripts/*.test.mjs"])];
  const path = "scripts/x.mjs";
  const { entries } = select({ suites, changed: [path], repoRoot: repo });
  const repoEntries = entries.filter((entry) => entry.suite === "repo");
  assert.equal(repoEntries.length, 1, path);
  assert.equal(repoEntries[0].why, `fallback: ${path}`);
  const attributed = entries.filter((entry) => entry.suite === "fix" && entry.why !== "windows");
  assert.deepEqual(attributed, [], "a repo-level change must not select a plugin test");
});

test("a workflow change selects every suite, because it decides what CI runs", (t) => {
  const repo = graphFixture(t);
  const suites = [suiteOf("fix", [FIX_GLOB]), suiteOf("repo", ["scripts/*.test.mjs"])];
  const path = ".github/workflows/test.yml";
  const { entries } = select({ suites, changed: [path], repoRoot: repo });
  for (const name of ["fix", "repo"]) {
    const chosenSuite = entries.filter((entry) => entry.suite === name);
    assert.ok(chosenSuite.length > 0, `${name} was not selected by ${path}`);
    assert.ok(chosenSuite.every((entry) => entry.why === `fallback: ${path}`), name);
  }
});

test("a .win.test.mjs is selected by a diff that touches none of it", (t) => {
  const entries = fixEntries(graphFixture(t), ["plugins/fix/notes.md"]);
  const win = selectedFile(entries, ".win.test.mjs");
  assert.equal(win.length, 1, JSON.stringify(entries));
  assert.equal(win[0].why, "windows");
});

test("--list prints <suite> <file> <why> and spawns no node --test", async (t) => {
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

test("** matches zero or more directories, * matches one level", (t) => {
  const repo = makeRepo(t);
  write(repo, "tests/a.test.mjs");
  write(repo, "tests/deep/b.test.mjs");
  write(repo, "tests/deep/deeper/c.test.mjs");

  const deep = expandRun({ cwd: ".", globs: ["tests/**/*.test.mjs"] }, { repoRoot: repo });
  assert.deepEqual(deep, ["tests/a.test.mjs", "tests/deep/b.test.mjs", "tests/deep/deeper/c.test.mjs"]);
  const flat = expandRun({ cwd: ".", globs: ["tests/*.test.mjs"] }, { repoRoot: repo });
  assert.deepEqual(flat, ["tests/a.test.mjs"]);
});

test("a whole-suite run whose globs match nothing exits 1 and names the glob", async (t) => {
  const repo = makeRepo(t);
  write(repo, "tests/a.test.mjs");
  const spawn = stubSpawn();
  const out = capture();
  const code = await main(["--suite", "empty"], {
    cwd: repo,
    _suites: [suiteOf("empty", ["nowhere/*.test.mjs"])],
    _spawn: spawn.spawn,
    _log: out.log,
    _err: out.err,
  });
  assert.equal(code, 1, "an empty whole-suite run reported success");
  assert.match(out.lines.join("\n"), /no file matched nowhere\/\*\.test\.mjs/);
  assert.equal(spawn.calls.length, 0, "an empty expansion spawned node --test bare");
});

test("--suite resolves only against the injected suite list", async (t) => {
  const repo = graphFixture(t);
  const out = capture();
  const code = await main(["--suite", "repo", "--list"], {
    cwd: repo,
    _suites: [suiteOf("repo", [FIX_GLOB])],
    _log: out.log,
    _err: out.err,
  });
  assert.equal(code, 0);
  assert.ok(out.lines.length > 0, "the injected suite selected nothing");
  for (const line of out.lines) assert.match(line, /^repo plugins\/fix\/tests\//, line);
});

test("a failing run exits 1 and the summary names it; all green exits 0", async (t) => {
  const repo = graphFixture(t);
  const lines = [];
  const run = (spawn) =>
    main(["--suite", "fix"], {
      cwd: repo,
      _suites: [suiteOf("fix", [FIX_GLOB])],
      _spawn: spawn.spawn,
      _log: (line) => lines.push(line),
      _err: () => {},
    });

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

test("killTree uses taskkill /T on win32 and the process group elsewhere", () => {
  const spawned = [];
  killTree(99, { platform: "win32", _spawnSync: (...args) => spawned.push(args) });
  assert.deepEqual(spawned[0], ["taskkill", ["/T", "/F", "/PID", "99"], { stdio: "ignore" }]);

  const killed = [];
  killTree(99, { platform: "linux", _kill: (pid, signal) => killed.push([pid, signal]) });
  assert.deepEqual(killed, [[-99, "SIGKILL"]]);
});

test("a run past its timeout is killed and reported failed", async (t) => {
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

/** A reporter's in-flight record, as the killed run would have left it. */
function inFlightRecord(repo, name, files) {
  const dir = join(repo, "test-results");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, name), JSON.stringify({ pid: 1, label: "slow", files }), "utf8");
}

test("A4: a timeout names this run's own unfinished files, and only those", async (t) => {
  const repo = graphFixture(t);
  const suite = suiteOf("slow", [FIX_GLOB]);
  suite.runs[0].timeoutMs = 30;
  inFlightRecord(repo, "slow.777.inflight.json", [
    { file: "plugins/fix/tests/transitive.test.mjs", startedAt: 0 },
    { file: "plugins/fix/tests/unrelated.test.mjs", startedAt: 0 },
  ]);
  inFlightRecord(repo, "slow.778.inflight.json", [
    { file: "plugins/fix/tests/join-cli.test.mjs", startedAt: 0 },
  ]);

  const lines = [];
  const code = await main(["--suite", "slow"], {
    cwd: repo,
    _suites: [suite],
    _spawn: stubSpawn({ never: true, pid: 777 }).spawn,
    _killTree: () => {},
    _now: () => 125000,
    _log: (line) => lines.push(line),
    _err: () => {},
  });

  const out = lines.join("\n");
  assert.equal(code, 1);
  assert.match(
    out,
    /still running: plugins\/fix\/tests\/transitive\.test\.mjs \(2m05s\), plugins\/fix\/tests\/unrelated\.test\.mjs \(2m05s\)/,
    out,
  );
  assert.ok(!out.includes("join-cli.test.mjs"), `another pid's record reached the reason:\n${out}`);
});

test("A4: a missing or corrupt in-flight record leaves the plain timeout reason", async (t) => {
  const repo = graphFixture(t);
  const suite = suiteOf("slow", [FIX_GLOB]);
  suite.runs[0].timeoutMs = 20;
  inFlightRecord(repo, "slow.777.inflight.json", []);
  writeFileSync(join(repo, "test-results", "slow.777.inflight.json"), "{not json", "utf8");

  const lines = [];
  const run = () => main(["--suite", "slow"], {
    cwd: repo,
    _suites: [suite],
    _spawn: stubSpawn({ never: true, pid: 777 }).spawn,
    _killTree: () => {},
    _log: (line) => lines.push(line),
    _err: () => {},
  });

  assert.equal(await run(), 1);
  assert.match(lines.join("\n"), /: TIMEOUT -- no exit within 20ms in /);
  assert.ok(!lines.join("\n").includes("still running"), lines.join("\n"));

  // The runner unlinked the corrupt record after the run; now it is absent too.
  lines.length = 0;
  assert.equal(await run(), 1);
  assert.match(lines.join("\n"), /: TIMEOUT -- no exit within 20ms in /);
});

// --- --fast ----------------------------------------------------------------

test("A7: --fast runs everything with no timings, then skips a measured-slow file", async (t) => {
  const repo = graphFixture(t);
  const suites = [suiteOf("fix", [FIX_GLOB])];

  const cold = stubSpawn();
  const coldOut = capture();
  assert.equal(await main(["--suite", "fix", "--fast"], {
    cwd: repo, _suites: suites, _spawn: cold.spawn, _log: coldOut.log, _err: coldOut.err,
  }), 0);
  assert.match(coldOut.lines.join("\n"), /--fast: no timings recorded yet; running everything/);
  assert.ok(cold.calls[0].args.includes("plugins/fix/tests/transitive.test.mjs"), "an unmeasured file was skipped");

  recordTimings({
    resultsDir: join(repo, "test-results"),
    repoRoot: repo,
    entries: [{ file: "plugins/fix/tests/transitive.test.mjs", ms: 45000 }],
  });

  const warm = stubSpawn();
  const warmOut = capture();
  assert.equal(await main(["--suite", "fix", "--fast"], {
    cwd: repo, _suites: suites, _spawn: warm.spawn, _log: warmOut.log, _err: warmOut.err,
  }), 0);
  assert.match(
    warmOut.lines.join("\n"),
    /--fast skipped 1 measured-slow file\(s\): plugins\/fix\/tests\/transitive\.test\.mjs/,
  );
  assert.ok(!warm.calls[0].args.includes("plugins/fix/tests/transitive.test.mjs"), "the measured-slow file still ran");
  assert.ok(warm.calls[0].args.includes("plugins/fix/tests/unrelated.test.mjs"), "a fast file was skipped too");
});

test("A7: a run --fast empties reports skipped and exits 0", async (t) => {
  const repo = graphFixture(t);
  const suites = [suiteOf("one", ["plugins/fix/tests/transitive.test.mjs"])];
  recordTimings({
    resultsDir: join(repo, "test-results"),
    repoRoot: repo,
    entries: [{ file: "plugins/fix/tests/transitive.test.mjs", ms: 45000 }],
  });

  const spawn = stubSpawn();
  const out = capture();
  const code = await main(["--suite", "one", "--fast"], {
    cwd: repo, _suites: suites, _spawn: spawn.spawn, _log: out.log, _err: out.err,
  });

  assert.equal(code, 0, out.lines.join("\n"));
  assert.equal(spawn.calls.length, 0, "an emptied run spawned node --test");
  assert.match(out.lines.join("\n"), /\[test\] one: SKIPPED -- --fast skipped 1 measured-slow file\(s\)/);
});

test("A7: --fast is refused with --wsl", async () => {
  const errors = [];
  const refuse = () => {
    throw new Error("a refused combination spawned a process");
  };
  const code = await main(["--wsl", "--fast"], {
    _spawn: refuse, _spawnSync: refuse, _log: () => {}, _err: (line) => errors.push(line),
  });
  assert.equal(code, 2);
  assert.match(errors.join("\n"), /--wsl cannot be combined with --fast/);
});

test("A10: --wsl refuses --reporter and --orphans, rather than ignoring them", async () => {
  for (const flag of ["--reporter=agent", "--orphans"]) {
    const errors = [];
    const refuse = () => {
      throw new Error(`--wsl ${flag} spawned a process`);
    };
    const code = await main(["--wsl", flag], {
      _spawn: refuse, _spawnSync: refuse, _log: () => {}, _err: (line) => errors.push(line),
    });
    assert.equal(code, 2, flag);
    assert.match(errors.join("\n"), new RegExp(`--wsl cannot be combined with ${flag.split("=")[0]}`));
  }
});

test("A10: --reporter=x exits 2 naming the two modes", async (t) => {
  const repo = makeRepo(t);
  write(repo, "seed.mjs");
  commitAll(repo, "seed"); // a resolvable base, so only the flag check can exit 2
  const errors = [];
  const refuse = () => {
    throw new Error("a rejected --reporter still ran a suite");
  };
  // An empty registry keeps the mutant's path cheap: without the check the
  // bad mode is accepted and the run reaches "nothing selected" as exit 0.
  const code = await main(["--reporter=x"], {
    cwd: repo,
    _suites: [],
    _spawn: refuse,
    _log: () => {},
    _err: (line) => errors.push(line),
  });
  assert.equal(code, 2);
  assert.match(errors.join("\n"), /--reporter must be agent or default, not x/);
});

// --- --orphans -------------------------------------------------------------

test("A8: --orphans exits 1 on a stray test and 0 once notRun lists it", async (t) => {
  const repo = makeRepo(t);
  write(repo, "plugins/x/tests/covered.test.mjs");
  write(repo, "other/y.test.mjs");
  const suites = [suiteOf("x", ["plugins/x/tests/*.test.mjs"])];

  const bad = capture();
  assert.equal(await main(["--orphans"], {
    cwd: repo, _suites: suites, _log: bad.log, _err: bad.err,
  }), 1);
  assert.deepEqual(bad.lines, ["other/y.test.mjs"]);

  const exempt = capture();
  assert.equal(await main(["--orphans"], {
    cwd: repo,
    _suites: suites,
    _notRun: [{ path: "other/y.test.mjs", reason: "fixture read by a suite" }],
    _log: exempt.log,
    _err: exempt.err,
  }), 0);
  assert.deepEqual(exempt.lines, []);
});

test("A8: an ordinary run warns about orphan test files on stderr", async (t) => {
  const repo = makeRepo(t);
  write(repo, "plugins/x/tests/covered.test.mjs");
  write(repo, "other/y.test.mjs");
  const out = capture();
  await main(["--suite", "x", "--list"], {
    cwd: repo, _suites: [suiteOf("x", ["plugins/x/tests/*.test.mjs"])], _log: out.log, _err: out.err,
  });
  assert.match(out.errors.join("\n"), /orphan test file\(s\) no suite runs: other\/y\.test\.mjs/);
});

// --- --if-selected ---------------------------------------------------------

/** A committed fixture with a second plugin whose only test is Windows-only,
 *  so a diff in `plugins/fix` leaves that suite with a `windows` entry alone. */
function ifSelectedRepo(t) {
  const repo = graphFixture(t);
  write(repo, "plugins/elsewhere/tests/x.win.test.mjs");
  commitAll(repo, "fixture");
  return repo;
}

async function ifSelectedRun(repo, suites, suiteName) {
  const spawn = stubSpawn();
  const out = capture();
  const code = await main(["--suite", suiteName, "--if-selected", "--against", "HEAD"], {
    cwd: repo, _suites: suites, _spawn: spawn.spawn, _log: out.log, _err: out.err,
  });
  return { code, out, spawn };
}

test("A9: --if-selected runs a selected suite whole and skips an unselected one", async (t) => {
  const repo = ifSelectedRepo(t);
  const suites = [
    suiteOf("fix", [FIX_GLOB]),
    suiteOf("elsewhere", ["plugins/elsewhere/tests/*.test.mjs"]),
  ];
  write(repo, "plugins/fix/src/a.mjs", "export const a = 2;\n");

  const selectedRun = await ifSelectedRun(repo, suites, "fix");
  assert.equal(selectedRun.code, 0);
  assert.ok(selectedRun.spawn.calls.length > 0, "a selected suite did not run");
  assert.ok(
    selectedRun.spawn.calls[0].args.includes("plugins/fix/tests/unrelated.test.mjs"),
    "the suite did not run whole",
  );

  const skipped = await ifSelectedRun(repo, suites, "elsewhere");
  assert.equal(skipped.code, 0);
  assert.equal(skipped.spawn.calls.length, 0, "an unselected suite spawned node --test");
  assert.match(skipped.out.lines.join("\n"), /^\[test\] elsewhere: not selected by this diff$/m);
});

test("A9: a runner, registry or workflow change runs every suite", async (t) => {
  const repo = ifSelectedRepo(t);
  const suites = [
    suiteOf("fix", [FIX_GLOB]),
    suiteOf("elsewhere", ["plugins/elsewhere/tests/*.test.mjs"]),
  ];
  for (const path of ["scripts/test-lib/select.mjs", "scripts/test-suites.mjs", ".github/workflows/test.yml"]) {
    write(repo, path);
    const { code, spawn } = await ifSelectedRun(repo, suites, "elsewhere");
    assert.equal(code, 0, path);
    assert.ok(spawn.calls.length > 0, `${path} did not run the suite`);
    rmSync(join(repo, path), { force: true });
  }
});

test("A9: a changed *.win.test.mjs selects its suite", async (t) => {
  const repo = ifSelectedRepo(t);
  const suites = [suiteOf("fix", [FIX_GLOB]), suiteOf("elsewhere", ["plugins/elsewhere/tests/*.test.mjs"])];
  write(repo, "plugins/fix/tests/extra.win.test.mjs");
  const { code, spawn } = await ifSelectedRun(repo, suites, "fix");
  assert.equal(code, 0);
  assert.ok(spawn.calls.length > 0, "a changed win test did not select its suite");
});

test("A9: --if-selected with an unresolvable base exits 2 and runs nothing", async (t) => {
  const repo = graphFixture(t);
  commitAll(repo, "fixture");
  const spawn = stubSpawn();
  const errors = [];
  const code = await main(["--suite", "fix", "--if-selected", "--against", "nosuchref"], {
    cwd: repo,
    _suites: [suiteOf("fix", [FIX_GLOB])],
    _spawn: spawn.spawn,
    _log: () => {},
    _err: (line) => errors.push(line),
  });
  assert.equal(code, 2);
  assert.match(errors.join("\n"), /not a ref/);
  assert.equal(spawn.calls.length, 0, "a selection error still spawned a run");
});

const memoryFs = (files) => ({
  existsSync: (path) => files.has(path),
  readFileSync: (path) => {
    if (!files.has(path)) throw new Error(`ENOENT ${path}`);
    return files.get(path);
  },
  writeFileSync: (path, value) => files.set(path, value),
  mkdirSync: () => {},
});

test("install runs when the hash is missing or differs, and is skipped when it matches", () => {
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
