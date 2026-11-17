// The runner's command line: --list and --suite output, the flag refusals, and
// the exit code each outcome produces.

import { test } from "node:test";
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { join } from "node:path";

import { main } from "./test.mjs";
import {
  FIX_GLOB,
  capture,
  commitAll,
  graphFixture,
  makeRepo,
  stubSpawn,
  suiteOf,
  write,
} from "./test-helpers.mjs";

// --- --list and --suite ----------------------------------------------------

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

// --- flag refusals ---------------------------------------------------------

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

test("A9: --if-selected on a suite whose globs match nothing exits 1, not 'not selected'", async (t) => {
  const repo = graphFixture(t);
  commitAll(repo, "fixture");
  const spawn = stubSpawn();
  const out = capture();
  const code = await main(["--suite", "empty", "--if-selected", "--against", "HEAD"], {
    cwd: repo,
    _suites: [suiteOf("empty", ["nowhere/*.test.mjs"])],
    _spawn: spawn.spawn,
    _log: out.log,
    _err: out.err,
  });

  assert.equal(code, 1, out.lines.join("\n"));
  assert.match(out.lines.join("\n"), /no file matched nowhere\/\*\.test\.mjs/);
  assert.equal(spawn.calls.length, 0, "an empty suite spawned node --test bare");
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
