// Test plan: repos/claude-plugin-marketplace/plans/swarm-cli-shim-test-plan.md
// Rows 1, 3, 5, 6, 7, 8 — the code half of the shim plan (row 2 lives in
// shim-sha-bump.test.mjs, row 4 in docs-no-hand-resolution.test.mjs).
// Every `swarm install` here runs against a fake HOME so nothing ever
// touches the real ~/.local/bin.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { runCli } from "./helpers/cli.mjs";
import { bashWrapper, cmdWrapper, installPlan } from "../src/cli-shim.mjs";

const BIN_ENTRY = fileURLToPath(new URL("../bin/swarm.mjs", import.meta.url));
const RESOLVER_SRC = fileURLToPath(new URL("../statusline/resolver.mjs", import.meta.url));
const KEY = "swarm@andrewmaston1988-claude-plugins";

const tmp = () => mkdtempSync(join(tmpdir(), "swarm-shim-"));

// os.homedir() reads USERPROFILE on win32, HOME on POSIX — set both.
const fakeHomeEnv = (home) => ({ HOME: home, USERPROFILE: home, SWARM_HOME: join(home, "swarm-home") });

// A registry-visible "install": bin/swarm.mjs printing a marker — exactly what
// the installed wrapper must reach. extra.statusline supplies the resolver's
// no-args target for row 8.
function fixtureInstall(root, marker, extra = {}) {
  mkdirSync(join(root, "bin"), { recursive: true });
  writeFileSync(join(root, "bin", "swarm.mjs"), `#!/usr/bin/env node\nconsole.log(${JSON.stringify(marker)});\n`);
  if (extra.statusline) {
    mkdirSync(join(root, "statusline"), { recursive: true });
    writeFileSync(join(root, "statusline", "swarm-statusline.mjs"), extra.statusline);
  }
  return root;
}

function writeRegistry(reg, entries) {
  writeFileSync(reg, JSON.stringify({ plugins: { [KEY]: entries } }));
  return reg;
}

const userEntry = (installPath, lastUpdated = "2026-09-09T00:00:00Z") => ({ scope: "user", installPath, lastUpdated });

// The installed wrapper, exactly as a user's shell runs it.
const runBashShim = (shimPath, env) =>
  spawnSync("bash", [shimPath], { encoding: "utf8", timeout: 30000, windowsHide: true, env: { ...process.env, ...env } });
const runCmdShim = (shimPath, env) =>
  spawnSync("cmd", ["/c", shimPath], { encoding: "utf8", timeout: 30000, windowsHide: true, env: { ...process.env, ...env } });
const bothShims = (shims, env) => shims.map((s) => (s.endsWith(".cmd") ? runCmdShim(s, env) : runBashShim(s, env)));

// Real `swarm install` into a fake home; returns the three installed paths.
function installInto(dir) {
  const home = join(dir, "home");
  mkdirSync(home);
  const r = runCli(["install"], { cwd: dir, env: fakeHomeEnv(home) });
  assert.equal(r.status, 0, `install failed: ${r.stderr}`);
  const userBin = join(home, ".local", "bin");
  return { home, userBin, resolver: join(userBin, "swarm-resolver.mjs"), bashShim: join(userBin, "swarm"), cmdShim: join(userBin, "swarm.cmd"), result: r };
}

test("row 1 (text): bash wrapper is LF + shebang; .cmd is CRLF + @echo off; both quote node and resolver and pass bin/swarm.mjs first", () => {
  const node = "C:\\Program Files\\nodejs\\node.exe";
  const resolver = "C:\\Users\\a\\.local\\bin\\swarm-resolver.mjs";
  const bash = bashWrapper(node, resolver);
  assert.ok(!bash.includes("\r"), "bash wrapper must be LF-only");
  assert.ok(bash.startsWith("#!/usr/bin/env bash\n"), "shebang first, LF-terminated");
  assert.ok(bash.endsWith("\n"));
  assert.ok(bash.includes(`exec "${node}" "${resolver}" bin/swarm.mjs "$@"`),
    "both paths quoted, resolver's first argument is bin/swarm.mjs");
  const cmd = cmdWrapper(node, resolver);
  assert.ok(cmd.startsWith("@echo off\r\n"), ".cmd starts @echo off and is CRLF");
  assert.ok(!/(?<!\r)\n/.test(cmd), "every newline in the .cmd is CRLF — cmd.exe parsing is unreliable on LF-only files");
  assert.ok(cmd.endsWith("\r\n"));
  assert.ok(cmd.includes(`"${node}" "${resolver}" bin/swarm.mjs %*`),
    "both paths quoted, resolver's first argument is bin/swarm.mjs");
});

test("row 5 (end-to-end): `swarm install` leaves three working files; the resolver copy is byte-identical; each wrapper runs a fixture install", () => {
  const dir = tmp();
  try {
    const { resolver, bashShim, cmdShim, result } = installInto(dir);
    assert.ok(existsSync(resolver) && existsSync(bashShim) && existsSync(cmdShim), "all three files written");
    assert.ok(readFileSync(resolver).equals(readFileSync(RESOLVER_SRC)),
      "the installed resolver must be byte-identical to statusline/resolver.mjs — a drifted copy is the stale-engine bug one level down");
    assert.ok(result.stdout.includes(join(resolver)), "install prints each written path");
    assert.ok(/PATH/.test(result.stdout), "install must name the ~/.local/bin-on-PATH precondition");
    const install = fixtureInstall(join(dir, "install"), "marker-row-5");
    const env = { SWARM_PLUGIN_REGISTRY: writeRegistry(join(dir, "installed_plugins.json"), [userEntry(install)]) };
    const shims = process.platform === "win32" ? bothShims([bashShim, cmdShim], env) : bothShims([bashShim], env);
    for (const r of shims) {
      assert.equal(r.status, 0, `wrapper failed: ${r.stderr}`);
      assert.ok(r.stdout.includes("marker-row-5"), `wrapper must print the fixture engine's marker: ${r.stdout}`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("row 5 (idempotence): a second install over the same dir leaves exactly the same three entries, same bytes, nothing appended", () => {
  const dir = tmp();
  try {
    const { userBin, resolver, bashShim, cmdShim } = installInto(dir);
    const snapshot = (d) => readdirSync(d).sort().map((f) => [f, readFileSync(join(d, f))]);
    const before = snapshot(userBin);
    const second = runCli(["install"], { cwd: dir, env: fakeHomeEnv(join(dir, "home")) });
    assert.equal(second.status, 0, second.stderr);
    assert.deepEqual(snapshot(userBin), before, "re-running install must overwrite, never append or duplicate");
    assert.equal(readdirSync(userBin).length, 3, "exactly three entries");
    // the refresh must also be a real rewrite: the installed copy tracks the
    // current resolver source, not the one from the first install
    assert.ok(readFileSync(resolver).equals(readFileSync(RESOLVER_SRC)));
    assert.ok(existsSync(bashShim) && existsSync(cmdShim));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("row 6: the real bin/swarm.mjs — not a fixture stand-in — dispatches the engine", () => {
  const dir = tmp();
  try {
    const env = {
      SWARM_HOME: join(dir, "home"),
      SWARM_PLUGIN_REGISTRY: writeRegistry(join(dir, "installed_plugins.json"), [userEntry(fixtureInstall(join(dir, "install"), "x"))]),
    };
    const runBin = (args) => spawnSync(process.execPath, [BIN_ENTRY, ...args], { encoding: "utf8", timeout: 60000, windowsHide: true, env: { ...process.env, ...env } });
    // The engine has no --help case; its pinned unknown-command contract (cli.test.mjs)
    // is usage on stderr + exit 1. Reaching it proves the one-line import ran the
    // REAL engine — the plan's "exit 0" for --help is wrong, no such case exists.
    const help = runBin(["--help"]);
    assert.equal(help.status, 1);
    assert.match(help.stderr, /usage:/);
    // and a real subcommand through bin exits 0 — full dispatch, not just the error path
    const status = runBin(["status", join(dir, "no-such-run")]);
    assert.equal(status.status, 0, status.stderr);
    assert.match(status.stdout, /no run\.log/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("row 3: absent / unparseable / entryless registry → readable diagnostic naming the fix, exit 1", () => {
  const dir = tmp();
  try {
    const { bashShim } = installInto(dir);
    const absent = join(dir, "absent.json");
    const bad = join(dir, "bad.json");
    writeFileSync(bad, "{ truncated");
    const empty = writeRegistry(join(dir, "empty.json"), []);
    for (const reg of [absent, bad, empty]) {
      const r = runBashShim(bashShim, { SWARM_PLUGIN_REGISTRY: reg });
      assert.equal(r.status, 1, `registry ${reg} must exit 1, got ${r.status}`);
      assert.match(r.stderr, /swarm resolver:/, `registry ${reg} needs the diagnostic prefix`);
      assert.ok(r.stderr.includes(reg) || r.stderr.includes("/reload-plugins"),
        `diagnostic must name the registry path or the fix: ${r.stderr}`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("row 7: an engine killed by signal exits the wrapper non-zero — never 0", () => {
  const dir = tmp();
  try {
    const { bashShim } = installInto(dir);
    // Fixture engine that traps nothing and kills itself.
    const install = join(dir, "install");
    mkdirSync(join(install, "bin"), { recursive: true });
    writeFileSync(join(install, "bin", "swarm.mjs"), "#!/usr/bin/env node\nprocess.kill(process.pid, \"SIGTERM\");\n");
    const env = { SWARM_PLUGIN_REGISTRY: writeRegistry(join(dir, "installed_plugins.json"), [userEntry(install)]) };
    const r = runBashShim(bashShim, env);
    // POSIX RED: a signalled child leaves r.status null and the pre-fix
    // resolver turned that into exit 0 — the defect D5 exists to close.
    // win32 has no status-less death: TerminateProcess carries code 1
    // (measured 2026-09-09: self-SIGTERM/SIGKILL → status 1, signal null), so
    // this leg pins the same user-facing contract — a killed run never reports
    // success — and the null-status branch is POSIX-only here. The other null
    // source, spawn failure, cannot occur: the resolver spawns process.execPath.
    assert.notEqual(r.status, 0, `a signal-killed engine must not exit the wrapper 0 (got ${r.status})`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("row 8: statusline mode still exits 0 on failure after the D5 change", () => {
  const dir = tmp();
  try {
    const { resolver } = installInto(dir);
    // (a) the plan's scenario: no swarm entry → the resolver's own fail() path,
    // blank line + exit 0. D5 must not leak into it.
    const empty = writeRegistry(join(dir, "empty.json"), []);
    const a = spawnSync(process.execPath, [resolver], { encoding: "utf8", windowsHide: true, env: { ...process.env, SWARM_PLUGIN_REGISTRY: empty } });
    assert.equal(a.status, 0, `statusline mode must exit 0 on failure, got ${a.status}\n${a.stderr}`);
    assert.equal(a.stdout, "\n", "a failed paint prints a blank line");
    // (b) the leg that actually detects a guard-less D5 fix: a statusline child
    // dying without an exit status must still be swallowed.
    //   POSIX: status null → 0; a careless `?? 1` fix turns it into 1 — the RED.
    //   win32: the killed child carries TerminateProcess code 1, a REAL status,
    //   so 1 propagates today, under the careless fix, and under the guarded fix
    //   alike — which also guards the opposite mutation (an overzealous
    //   "statusline always exits 0" that would swallow genuine exit codes).
    const install = fixtureInstall(join(dir, "install"), "x", {
      statusline: "#!/usr/bin/env node\nprocess.kill(process.pid, \"SIGTERM\");\n",
    });
    const env = { ...process.env, SWARM_PLUGIN_REGISTRY: writeRegistry(join(dir, "installed_plugins.json"), [userEntry(install)]) };
    const b = spawnSync(process.execPath, [resolver], { encoding: "utf8", windowsHide: true, env });
    assert.equal(b.status, process.platform === "win32" ? 1 : 0,
      `statusline mode must swallow a status-less death (0 on POSIX) and keep propagating a real status (1 on win32); got ${b.status}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});