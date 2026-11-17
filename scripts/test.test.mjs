// Tests for the runner's own mechanics: the registry and its CI wiring, the
// spawn/env contract, kill and timeout handling, --fast, and installs.
// Failures are in the execution itself, so spawn and the clock are injected.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { SUITES, findSuite } from "./test-suites.mjs";
import { installIfNeeded, killTree, main, runSuites } from "./test.mjs";
import { recordTimings } from "./test-lib/fast.mjs";
import { FIX_GLOB, HERE, capture, graphFixture, stubSpawn, suiteOf } from "./test-helpers.mjs";

const WORKFLOW = join(HERE, "..", ".github", "workflows", "test.yml");

test("no two runs of a suite share a label, so neither log overwrites the other", () => {
  for (const suite of SUITES) {
    const labels = suite.runs.map((run) => `${suite.name}${run.label ? `[${run.label}]` : ""}`);
    assert.equal(new Set(labels).size, labels.length, `${suite.name}: ${labels.join(", ")}`);
  }
});

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
  const kept = ["500-line bar", "Configure git identity", "Plant read-only home sentinels",
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

// --- runs, spawn and timeouts ----------------------------------------------

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

test("a run cleared a stale log before a timeout, so the log line is not printed", async (t) => {
  const repo = graphFixture(t);
  const suite = suiteOf("slow", [FIX_GLOB]);
  suite.runs[0].timeoutMs = 20;
  const dir = join(repo, "test-results");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "slow.log"), "the previous run\n", "utf8");

  const lines = [];
  const code = await main(["--suite", "slow"], {
    cwd: repo,
    _suites: [suite],
    _spawn: stubSpawn({ never: true, pid: 777 }).spawn,
    _killTree: () => {},
    _log: (line) => lines.push(line),
    _err: () => {},
  });

  assert.equal(code, 1);
  assert.ok(!lines.join("\n").includes("log:"), `a killed run pointed at the last run's log:\n${lines.join("\n")}`);
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

// --- install ---------------------------------------------------------------

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
