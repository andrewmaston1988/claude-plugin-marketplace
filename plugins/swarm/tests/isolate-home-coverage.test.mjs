import "./helpers/isolate-home.mjs";
import { test } from "node:test";
import { equal, ok } from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { homedir, tmpdir } from "node:os";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

const TESTS = fileURLToPath(new URL(".", import.meta.url));
const HELPER = join(TESTS, "helpers", "isolate-home.mjs");

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
