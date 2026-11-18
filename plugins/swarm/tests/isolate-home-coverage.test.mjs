import "./helpers/isolate-home.mjs";
import { test } from "node:test";
import { equal, match, ok } from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join, relative, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const TESTS = fileURLToPath(new URL(".", import.meta.url));
const HELPER = join(TESTS, "helpers", "isolate-home.mjs");
const LEAK_FIXTURE = join(TESTS, "fixtures", "temp-leak.fixture.mjs");

function testFiles(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...testFiles(path));
    else if (entry.name.endsWith(".test.mjs")) out.push(path);
  }
  return out;
}

// The specifier depends on the file's depth, so a test under tests/sub/ must
// climb out with "..".
function helperSpecifier(file) {
  const rel = relative(dirname(file), HELPER).split(sep).join("/");
  return rel.startsWith(".") ? rel : `./${rel}`;
}

// Leading whitespace, line comments and block comments are not statements: a
// file may open with a comment block and still isolate first.
function firstStatement(text) {
  let i = 0;
  for (;;) {
    while (i < text.length && /\s/.test(text[i])) i++;
    if (text.startsWith("//", i)) {
      const end = text.indexOf("\n", i);
      i = end === -1 ? text.length : end + 1;
    } else if (text.startsWith("/*", i)) {
      const end = text.indexOf("*/", i + 2);
      i = end === -1 ? text.length : end + 2;
    } else {
      const end = text.indexOf(";", i);
      return end === -1 ? text.slice(i) : text.slice(i, end + 1);
    }
  }
}

function git(args) {
  const r = spawnSync("git", args, { encoding: "utf8" });
  return r.status === 0 ? r.stdout.trim() : "";
}

test("every test file opens with the home-isolation import", () => {
  const files = testFiles(TESTS);
  const offenders = files.filter(
    (file) => firstStatement(readFileSync(file, "utf8")) !== `import "${helperSpecifier(file)}";`,
  );
  equal(
    offenders.length,
    0,
    `${offenders.length} of ${files.length} test files open with something other than the home-isolation import. ` +
      `A file run on its own then resolves SWARM_HOME and HOME to the operator's real profile.\n` +
      offenders.map((file) => `  ${relative(TESTS, file)}  ->  import "${helperSpecifier(file)}";`).join("\n"),
  );
});

// Built from parts so this file's own source never matches the patterns it enforces.
const HOME_CALL = "swarm" + "Home()";
const CONFIG_ARG = `${HOME_CALL}, "config.json"`;
const MUTATOR = /writeFileSync|renameSync|rmSync|unlinkSync|rmdirSync/;

// A line that names the home's config is flagged even without a mutator: hoisting
// the path into `configPath` is how a write and its restore once hid from a
// call-site check.
function homeWrites(file) {
  const hits = [];
  readFileSync(file, "utf8").split("\n").forEach((line, i) => {
    if (line.trimStart().startsWith("//")) return;
    if (line.includes(CONFIG_ARG) || (line.includes(HOME_CALL) && MUTATOR.test(line))) {
      hits.push(`  ${relative(TESTS, file)}:${i + 1}  ${line.trim()}`);
    }
  });
  return hits;
}

test("no test writes, renames or removes under the home it runs in", () => {
  const hits = testFiles(TESTS).flatMap(homeWrites);
  equal(
    hits.length,
    0,
    "a test writes or deletes inside the home it runs in — without isolation that home is the operator's real profile:\n" +
      hits.join("\n"),
  );
});

test("a test process runs against one throwaway home and a git config it owns", () => {
  ok(process.env.SWARM_HOME, "the helper must set SWARM_HOME");
  equal(
    homedir(),
    process.env.SWARM_HOME,
    "os.homedir() must be the throwaway SWARM_HOME; anything else reads or writes the operator's real home",
  );

  const config = process.env.GIT_CONFIG_GLOBAL;
  ok(config, "the helper must point GIT_CONFIG_GLOBAL at its own config");
  equal(
    dirname(config),
    process.env.SWARM_HOME,
    "the git config must live in the throwaway home, never the operator's profile",
  );

  // A CLI child (and a node --test worker) reads the env, not this module's state.
  const child = spawnSync(process.execPath, ["-e", "process.stdout.write(process.env.GIT_CONFIG_GLOBAL || '')"], {
    encoding: "utf8",
  });
  equal(child.stdout, config, "a child a test spawns must see the same config");

  const hooks = spawnSync("git", ["config", "--global", "--get", "core.hooksPath"], { encoding: "utf8" });
  equal(
    hooks.status,
    1,
    `a test must not reach the operator's global hooks; core.hooksPath resolved to ${hooks.stdout.trim()}`,
  );
  equal(
    git(["config", "--global", "--get", "user.name"]),
    "Swarm Test",
    "the config must carry the fixed test identity so fixture commits succeed",
  );
});

// The helper's config is a global file precisely so a repo-local core.hooksPath
// still wins. Routed through GIT_CONFIG_COUNT it would shadow the repo's own.
test("a repo-local core.hooksPath still runs its hook", () => {
  const repo = mkdtempSync(join(tmpdir(), "swarm-hook-repo-"));
  const hooks = mkdtempSync(join(tmpdir(), "swarm-hook-dir-"));
  const marker = join(hooks, "fired").replaceAll("\\", "/");
  try {
    spawnSync("git", ["init", "-q", "-b", "main"], { cwd: repo });
    writeFileSync(join(hooks, "pre-commit"),
      `#!/bin/sh\nnode -e "require('fs').writeFileSync(process.argv[1], 'x')" '${marker}'\n`,
      { mode: 0o755 });
    spawnSync("git", ["config", "core.hooksPath", hooks], { cwd: repo });
    const commit = spawnSync("git", ["commit", "-q", "--allow-empty", "-m", "x"], { cwd: repo, encoding: "utf8" });
    equal(commit.status, 0, `the commit must succeed: ${commit.stderr}`);
    ok(existsSync(join(hooks, "fired")), "a repo-local core.hooksPath must run its pre-commit hook");
  } finally {
    rmSync(repo, { recursive: true, force: true });
    rmSync(hooks, { recursive: true, force: true });
  }
});

// The helper also redirects the temp root into the home it mints. That is what stops
// a bare `node --test` — no test runner around it — from littering the OS temp dir.

test("a test process leaves nothing in the outer temp root", () => {
  const outer = mkdtempSync(join(tmpdir(), "swarm-outer-"));
  try {
    // SWARM_HOME and SWARM_TEST_HOME are what the helper checks, so a child that saw
    // them would mint no home and prove nothing. NODE_TEST_CONTEXT makes a child think
    // it is nested and skip its files, so it goes too — and the pass count below is
    // the proof the fixture's test actually ran.
    const env = { ...process.env, TEMP: outer, TMP: outer, TMPDIR: outer };
    delete env.SWARM_HOME;
    delete env.SWARM_TEST_HOME;
    delete env.NODE_TEST_CONTEXT;
    // TAP pinned: the default reporter (and so the pass line) differs by Node version.
    const run = spawnSync(process.execPath, ["--test", "--test-reporter=tap", LEAK_FIXTURE], {
      encoding: "utf8",
      env,
    });
    const output = `${run.stdout}${run.stderr}`;
    equal(run.status, 0, `the fixture must pass:\n${output}`);
    match(output, /^# pass 1$/m, `the fixture's test must run, not be skipped:\n${output}`);

    const entries = readdirSync(outer);
    equal(
      entries.filter((entry) => entry.startsWith("leak-")).length,
      0,
      `the fixture's temp dir landed in the outer temp root: ${entries.join(", ")}`,
    );
    equal(
      entries.filter((entry) => entry !== "swarm").length,
      0,
      `only the shared swarm dir may remain in the outer temp root: ${entries.join(", ")}`,
    );
  } finally {
    rmSync(outer, { recursive: true, force: true });
  }
});

test("os.tmpdir() is under the one swarm temp dir, outside the home", () => {
  const home = process.env.SWARM_HOME;
  equal(
    basename(dirname(home)),
    "swarm",
    `the home must sit under one swarm temp dir, not directly in the temp root: ${home}`,
  );
  equal(
    dirname(tmpdir()),
    dirname(home),
    `os.tmpdir() is ${tmpdir()}, not under the same swarm dir as the home ${home}: a temp dir made there outlives the run`,
  );
  ok(
    !tmpdir().startsWith(home),
    `os.tmpdir() is inside the home ${home} — the governance gate reads everything under it as a swarm-owned tree`,
  );
});

test("a child that imports the helper reuses this home and temp dir", () => {
  // The child has to load the helper, or there is nothing in it that could mint a
  // second home — a bare `node -e` would pass no matter what the helper did.
  const script = [
    'import { tmpdir } from "node:os";',
    `await import(${JSON.stringify(pathToFileURL(HELPER).href)});`,
    'process.stdout.write(JSON.stringify({ home: process.env.SWARM_HOME, tmp: tmpdir() }) + "\\n");',
  ].join("\n");
  const run = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
    encoding: "utf8",
    env: process.env,
  });
  equal(run.status, 0, `the child must run:\n${run.stderr}`);
  // The first line only: importing node:test makes the child print a run summary at exit.
  const seen = JSON.parse(run.stdout.split("\n")[0]);
  equal(seen.home, process.env.SWARM_HOME, "a child that inherits SWARM_TEST_HOME must not mint a second home");
  equal(seen.tmp, tmpdir(), "a child must inherit the redirected temp dir, not resolve the OS temp root");
});
