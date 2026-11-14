import "./helpers/isolate-home.mjs";
import { test } from "node:test";
import { equal, ok } from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { homedir, userInfo } from "node:os";
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

// os.userInfo() reports the passwd / OS account home, not $HOME, so it still
// names the operator's real home after this helper has moved HOME.
function originalHome() {
  try {
    return userInfo().homedir;
  } catch {
    return null;
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

test("a test process runs against one throwaway home, with git's global config carried across", () => {
  ok(process.env.SWARM_HOME, "the helper must set SWARM_HOME");
  equal(
    homedir(),
    process.env.SWARM_HOME,
    "os.homedir() must be the throwaway SWARM_HOME; anything else reads or writes the operator's real home",
  );

  const home = originalHome();
  const realGlobal = home && join(home, ".gitconfig");
  if (!realGlobal || !existsSync(realGlobal)) return;

  equal(
    git(["config", "--global", "--get", "user.name"]),
    git(["config", "--file", realGlobal, "--get", "user.name"]),
    "moving HOME hides git's global config; the helper must carry it across so commits still get an identity",
  );
});
