// Tests for WSL mode (`scripts/test-lib/wsl.mjs`) — test plan rows 11 and 12.
//
// A fake spawnSync records every call, so the mirror's step ORDER and the
// ARGUMENT-ARRAY shape of each wsl.exe call are both asserted without a distro.
// Real distro behaviour is the main session's smoke run.

import { test } from "node:test";
import assert from "node:assert/strict";

import { DISTRO, SETUP_POINTER, distroList, runWsl, toWslPath } from "./test-lib/wsl.mjs";

const HEAD = "8aac8ba6e100a08c1aa33c9286aeecd45a21bf36";
const REPO_ROOT = "C:\\code\\claude-plugin-marketplace";
const HOME = "/home/ubuntu";
const MIRROR = `${HOME}/mirror/claude-plugin-marketplace`;
const SOURCE = "/mnt/c/code/claude-plugin-marketplace/.git";
const TREE = "/mnt/c/code/claude-plugin-marketplace/";

const plain = (...argv) => ["-d", DISTRO, "--", ...argv];
const inMirror = (...argv) => ["-d", DISTRO, "--cd", MIRROR, "--", ...argv];

// --- Fixture plumbing ------------------------------------------------------

/** Records every spawn and answers with scripted results. */
function makeFake(options = {}) {
  const {
    distros = ["docker-desktop", DISTRO],
    listEncoding = "utf16le",
    head = HEAD,
    commonDir = "C:/code/claude-plugin-marketplace/.git",
    home = HOME,
    mirrorOrigin = null,
    mirrorExists = false,
    runStatus = 0,
    failOn = null,
  } = options;
  const calls = [];

  const spawn = (cmd, args = [], opts = {}) => {
    calls.push({ cmd, args, opts });
    const line = args.join(" ");
    if (cmd === "git") {
      if (line === "rev-parse HEAD") return { status: 0, stdout: `${head}\n` };
      if (line === "rev-parse --git-common-dir") return { status: 0, stdout: `${commonDir}\n` };
      throw new Error(`unexpected local git call: ${line}`);
    }
    if (cmd !== "wsl.exe") throw new Error(`unexpected command: ${cmd}`);
    if (line === "-l -q") {
      const list = distros.length ? `${distros.join("\r\n")}\r\n` : "";
      return { status: 0, stdout: Buffer.from(list, listEncoding) };
    }

    const inner = args.slice(args.indexOf("--") + 1).join(" ");
    const step = (value) => (failOn && inner.startsWith(failOn) ? { status: 1, stderr: "boom\n" } : value);
    if (inner === "printenv HOME") return step({ status: 0, stdout: Buffer.from(`${home}\n`) });
    if (inner === "git config --get remote.origin.url") {
      return mirrorOrigin === null
        ? { status: 1, stderr: "fatal: not a git repository\n" }
        : step({ status: 0, stdout: Buffer.from(`${mirrorOrigin}\n`) });
    }
    if (inner.startsWith("mkdir -p ")) return step({ status: 0 });
    if (inner.startsWith("test -d ")) return { status: mirrorExists ? 0 : 1 };
    if (inner.startsWith("rm -rf ")) return step({ status: 0 });
    if (inner.startsWith("git clone ")) return step({ status: 0 });
    if (inner === "git config core.fileMode false") return step({ status: 0 });
    if (inner === "git fetch --quiet origin") return step({ status: 0 });
    if (inner.startsWith("git checkout ")) return step({ status: 0 });
    if (inner.startsWith("rsync ")) return step({ status: 0 });
    if (inner.startsWith("node ")) return { status: runStatus };
    throw new Error(`unexpected wsl.exe call: ${line}`);
  };

  const innerLines = () =>
    calls
      .filter((c) => c.cmd === "wsl.exe")
      .map((c) => c.args.slice(c.args.indexOf("--") + 1).join(" "));
  return { spawn, calls, innerLines };
}

function makeFs(exists = true) {
  return { existsSync: () => exists };
}

/** `process.stderr` is the only place the module reports a refusal, so the
 *  test reads it there rather than taking a second injected writer. */
async function withStderr(fn) {
  const original = process.stderr.write;
  let captured = "";
  process.stderr.write = (chunk) => {
    captured += String(chunk);
    return true;
  };
  try {
    const result = await fn();
    return { result, stderr: captured };
  } finally {
    process.stderr.write = original;
  }
}

async function run(fake, options = {}) {
  const logs = [];
  const code = await runWsl({
    repoRoot: options.repoRoot ?? REPO_ROOT,
    command: options.command ?? ["node", "scripts/test.mjs", "--all"],
    _spawnSync: fake.spawn,
    _fs: makeFs(options.repoExists ?? true),
    log: (line) => logs.push(line),
  });
  return { code, logs };
}

// --- Row 11: the distro has to exist ---------------------------------------

test("no plugin-dev in the distro list exits 2 and prints the setup pointer", async () => {
  const fake = makeFake({ distros: ["docker-desktop"] });
  const { result: code, stderr } = await withStderr(async () => (await run(fake)).code);

  assert.equal(code, 2);
  assert.match(stderr, /TESTING\.md/);
  assert.match(stderr, /plugin-dev/);
  assert.equal(SETUP_POINTER.includes("TESTING.md"), true, "the pointer must name TESTING.md");
  assert.deepEqual(
    fake.calls.map((c) => c.args),
    [["-l", "-q"]],
    "nothing may be spawned once the distro is known to be missing",
  );
});

test("the distro list decodes from UTF-16LE and from plain UTF-8", () => {
  const utf16 = Buffer.from("docker-desktop\r\nplugin-dev\r\n", "utf16le");
  assert.deepEqual(distroList(utf16), ["docker-desktop", "plugin-dev"]);
  assert.deepEqual(
    distroList(Buffer.from("docker-desktop\nplugin-dev\n", "utf8")),
    ["docker-desktop", "plugin-dev"],
  );
  assert.deepEqual(distroList(Buffer.from("")), []);
  assert.deepEqual(distroList(Buffer.from("\uFEFFplugin-dev\r\n", "utf16le")), ["plugin-dev"]);
});

// --- Row 11: the mirror steps, in order ------------------------------------

test("a first sync clones, pins the checkout, rsyncs and then runs the command", async () => {
  const fake = makeFake();
  const { code, logs } = await run(fake);

  assert.equal(code, 0);
  assert.deepEqual(
    fake.calls.filter((c) => c.cmd === "wsl.exe").map((c) => c.args),
    [
      ["-l", "-q"],
      plain("printenv", "HOME"),
      inMirror("git", "config", "--get", "remote.origin.url"),
      plain("mkdir", "-p", `${HOME}/mirror`),
      plain("test", "-d", MIRROR),
      plain("git", "clone", "--quiet", SOURCE, MIRROR),
      inMirror("git", "config", "core.fileMode", "false"),
      inMirror("git", "fetch", "--quiet", "origin"),
      inMirror("git", "checkout", "--force", "--detach", HEAD),
      plain(
        "rsync",
        "-rlt",
        "--delete",
        "--exclude",
        ".git",
        "--exclude",
        "node_modules",
        TREE,
        `${MIRROR}/`,
      ),
      inMirror("node", "scripts/test.mjs", "--all"),
    ],
  );
  assert.ok(logs.length > 0, "the caller wants progress lines");
});

test("a mirror already cloned from this repo syncs without cloning again", async () => {
  const fake = makeFake({ mirrorOrigin: SOURCE, mirrorExists: true });
  const { code } = await run(fake);

  assert.equal(code, 0);
  const lines = fake.innerLines();
  assert.ok(!lines.some((l) => l.startsWith("git clone")), lines.join("\n"));
  assert.ok(!lines.some((l) => l === "git config core.fileMode false"), "fileMode is set at clone time");
  assert.ok(!lines.some((l) => l.startsWith("rm -rf")), "a usable mirror must never be deleted");
  assert.ok(lines.includes("git fetch --quiet origin"));
  assert.ok(lines.some((l) => l.startsWith("git checkout --force --detach ")));
  assert.ok(lines.some((l) => l.startsWith("rsync -rlt ")));
  assert.equal(lines[lines.length - 1], "node scripts/test.mjs --all");
});

test("a mirror cloned from another remote is replaced, not reused", async () => {
  const fake = makeFake({
    mirrorOrigin: "https://github.com/someone/else.git",
    mirrorExists: true,
  });
  const { code } = await run(fake);

  assert.equal(code, 0);
  const lines = fake.innerLines();
  const removed = lines.indexOf(`rm -rf ${MIRROR}`);
  const cloned = lines.indexOf(`git clone --quiet ${SOURCE} ${MIRROR}`);
  assert.ok(removed !== -1, `no removal in:\n${lines.join("\n")}`);
  assert.ok(cloned !== -1, `no clone in:\n${lines.join("\n")}`);
  assert.ok(removed < cloned, "the stale mirror is removed before the clone");
  assert.ok(lines.includes("git config core.fileMode false"), "a fresh clone gets fileMode false");
});

test("the rsync copies no permissions and keeps .git and node_modules", async () => {
  const fake = makeFake();
  await run(fake);

  const args = fake.calls.find((c) => c.args.includes("rsync")).args;
  assert.ok(args.includes("-rlt"), args.join(" "));
  assert.ok(!args.includes("-a"), "-a copies /mnt/c's 777 modes and dirties every file");
  assert.ok(!args.includes("-p"), "-p copies modes too");
  assert.ok(args.includes("--delete"), "a file deleted on Windows must vanish from the mirror");
  assert.deepEqual(args.slice(args.indexOf("--exclude"), args.indexOf("--exclude") + 2), [
    "--exclude",
    ".git",
  ]);
  assert.ok(args.includes("node_modules"));
});

// --- Row 11: every wsl.exe call is an argument array -----------------------

test("wsl.exe is never given a shell string", async () => {
  for (const options of [{}, { mirrorOrigin: SOURCE, mirrorExists: true }]) {
    const fake = makeFake(options);
    await run(fake);
    for (const { cmd, args, opts } of fake.calls.filter((c) => c.cmd === "wsl.exe")) {
      assert.ok(Array.isArray(args), `args must be an array, got ${typeof args}`);
      assert.equal(opts.shell, undefined, "no shell: wsl.exe re-quotes a command string");
      for (const arg of args) {
        assert.equal(typeof arg, "string");
        assert.doesNotMatch(arg, /(^|\s)(bash|sh|cmd|powershell)\s+-c/, `shell string in ${arg}`);
        assert.doesNotMatch(arg, /^["'].*["']$/, `quoted command string in ${arg}`);
      }
      // A command handed over as one string is what wsl.exe re-quotes.
      for (const arg of args.slice(args.indexOf("--") + 1)) {
        assert.doesNotMatch(
          arg,
          /^(git|rsync|node|rm|mkdir|test|printenv)\s+\S/,
          `a whole command reached wsl.exe as one argument: ${arg}`,
        );
      }
    }
  }
});

test("the mirror is named after the repository and lives under the WSL home", async () => {
  const fake = makeFake();
  await run(fake);
  const clone = fake.calls.find((c) => c.args.includes("clone")).args;
  assert.equal(clone[clone.length - 1], MIRROR);
  assert.ok(MIRROR.startsWith(`${HOME}/mirror/`), MIRROR);
});

// --- Row 11: the exit code and streaming ----------------------------------

test("the command's exit code is the runner's exit code", async () => {
  assert.equal((await run(makeFake({ runStatus: 0 }))).code, 0);
  assert.equal((await run(makeFake({ runStatus: 7 }))).code, 7);
});

test("the command runs in the mirror with inherited stdio", async () => {
  const fake = makeFake();
  await run(fake, { command: ["node", "scripts/test.mjs", "--all"] });

  const last = fake.calls[fake.calls.length - 1];
  assert.deepEqual(last.args, inMirror("node", "scripts/test.mjs", "--all"));
  assert.equal(last.opts.stdio, "inherit", "output must stream, not buffer behind the run");
});

test("a failed mirror step stops before the command runs", async () => {
  const fake = makeFake({ failOn: "git fetch" });
  const { result: code, stderr } = await withStderr(async () => (await run(fake)).code);

  assert.equal(code, 2);
  assert.match(stderr, /git fetch failed/);
  assert.ok(!fake.innerLines().some((l) => l.startsWith("node ")), "the suite must not run");
});

test("a repository root that does not exist exits 2", async () => {
  const fake = makeFake();
  const { result: code } = await withStderr(async () => (await run(fake, { repoExists: false })).code);
  assert.equal(code, 2);
  assert.deepEqual(
    fake.calls.filter((c) => c.cmd === "wsl.exe").map((c) => c.args),
    [["-l", "-q"]],
    "no work is attempted beyond the distro list",
  );
});

// --- Row 12: path conversion ---------------------------------------------

test("a Windows path converts to its /mnt form", () => {
  assert.equal(toWslPath("C:\\a\\b"), "/mnt/c/a/b");
  assert.equal(toWslPath("C:/a/b"), "/mnt/c/a/b");
  assert.equal(toWslPath("D:\\work\\tree"), "/mnt/d/work/tree");
  assert.equal(toWslPath("c:/x"), "/mnt/c/x");
  assert.equal(toWslPath("C:\\Users\\Andrew\\.swarm\\wt"), "/mnt/c/Users/Andrew/.swarm/wt");
});

test("a path already on the Linux side is left alone", () => {
  assert.equal(toWslPath("/home/ubuntu/mirror/x"), "/home/ubuntu/mirror/x");
  assert.equal(toWslPath("/mnt/c/a/b"), "/mnt/c/a/b");
});

test("a linked worktree's common dir converts to the clone source", async () => {
  // This worktree is a linked one: `--git-common-dir` prints the main
  // checkout's absolute path, which is what makes the clone see local commits.
  const fake = makeFake({ commonDir: "C:/code/claude-plugin-marketplace/.git" });
  await run(fake);

  const clone = fake.calls.find((c) => c.args.includes("clone")).args;
  assert.equal(clone[clone.length - 2], "/mnt/c/code/claude-plugin-marketplace/.git");
  assert.equal(clone[clone.length - 1], `${HOME}/mirror/claude-plugin-marketplace`);
});

test("a relative common dir resolves against the worktree root", async () => {
  const fake = makeFake({ commonDir: ".git" });
  await run(fake);

  const clone = fake.calls.find((c) => c.args.includes("clone")).args;
  assert.equal(clone[clone.length - 2], SOURCE, "a main-checkout `.git` must resolve, not clone `.git`");
});

test("the rsync source is the worktree root, converted, with a trailing slash", async () => {
  const fake = makeFake();
  await run(fake);

  const args = fake.calls.find((c) => c.args.includes("rsync")).args;
  const source = args[args.length - 2];
  assert.equal(source, TREE);
  assert.ok(source.endsWith("/"), "a missing trailing slash copies the directory, not its contents");
  assert.equal(args[args.length - 1], `${MIRROR}/`);
});
