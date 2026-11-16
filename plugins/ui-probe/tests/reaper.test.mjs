import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { join, sep } from "node:path";
import { tmpdir } from "node:os";
import {
  OWNER_FILE,
  PROFILE_PREFIX,
  isUiProbeProfile,
  killBrowserForProfile,
  killPids,
  listProcessesPosix,
  listProcessesWindows,
  ownerStartMs,
  preScanProfiles,
  queryProcessStart,
  readOwnerFile,
  reapOrphans,
  sweepProfiles,
  writeOwnerFile,
} from "../src/reaper.mjs";

const OLD = 2 * 60 * 60 * 1000;

function tempRoot(t) {
  const dir = mkdtempSync(join(tmpdir(), "ui-probe-reaper-test-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function profileFolder(root, suffix) {
  const path = join(root, `${PROFILE_PREFIX}${suffix}`);
  mkdirSync(path);
  return path;
}

function aged(path, ms = OLD) {
  const seconds = (Date.now() - ms) / 1000;
  utimesSync(path, seconds, seconds);
}

function cmdFor(profile, exe = "msedge.exe") {
  return `"C:\\Browsers\\${exe}" --headless=new --remote-debugging-port=0 --user-data-dir="${profile}"`;
}

function recorder() {
  const calls = [];
  const kill = (pids, options) => {
    calls.push({ pids, options });
    return { killed: pids };
  };
  kill.calls = calls;
  return kill;
}

// --- row 3: ownership verdicts ------------------------------------------------

test("row 3: a browser whose owner is dead is stopped", async (t) => {
  const dir = tempRoot(t);
  const profile = profileFolder(dir, "dead");
  writeOwnerFile(profile, { pid: 9001, startMs: 1_000 });
  const kill = recorder();
  const result = await reapOrphans({
    tmpDir: dir,
    listProcesses: () => [{ pid: 4001, cmd: cmdFor(profile) }],
    kill,
    isAlive: () => false,
    queryStart: () => null,
  });
  assert.deepEqual(kill.calls, [{ pids: [4001], options: { platform: process.platform, timeoutMs: 5000 } }]);
  assert.deepEqual(result.killed, [4001]);
});

test("row 3: a live owner with its recorded start time is left alone", async (t) => {
  const dir = tempRoot(t);
  const profile = profileFolder(dir, "live");
  const ownerPid = 9001;
  writeOwnerFile(profile, { pid: ownerPid, startMs: 1_000_000 });
  aged(profile); // force the pre-scan to consult the lister
  const kill = recorder();
  const result = await reapOrphans({
    tmpDir: dir,
    listProcesses: () => [{ pid: 4001, cmd: cmdFor(profile, "chrome.exe") }],
    kill,
    isAlive: (pid) => pid === ownerPid,
    queryStart: (pid) => (pid === ownerPid ? 1_000_000 : null),
  });
  assert.deepEqual(kill.calls, []);
  assert.deepEqual(result.killed, []);
  assert.ok(existsSync(profile), "a held old profile is not swept");
});

test("row 3: a reused PID is stopped even though its owner looks alive", async (t) => {
  const dir = tempRoot(t);
  const profile = profileFolder(dir, "reused");
  writeOwnerFile(profile, { pid: 9001, startMs: 1_000_000 });
  const kill = recorder();
  await reapOrphans({
    tmpDir: dir,
    listProcesses: () => [{ pid: 4001, cmd: cmdFor(profile, "chrome.exe") }],
    kill,
    isAlive: (pid) => pid === 9001,
    queryStart: (pid) => (pid === 9001 ? 1_005_000 : null), // 5 s apart
  });
  assert.deepEqual(kill.calls[0].pids, [4001]);
});

test("row 3: an unreadable start time is left alone, never killed on a guess", async (t) => {
  const dir = tempRoot(t);
  const profile = profileFolder(dir, "unknown");
  writeOwnerFile(profile, { pid: 9001, startMs: 1_000 });
  aged(profile);
  const kill = recorder();
  await reapOrphans({
    tmpDir: dir,
    listProcesses: () => [{ pid: 4001, cmd: cmdFor(profile) }],
    kill,
    isAlive: () => true,
    queryStart: () => null,
  });
  assert.deepEqual(kill.calls, []);
});

test("row 3: an ownerless browser is stopped only past the grace", async (t) => {
  const dir = tempRoot(t);
  const oldProfile = profileFolder(dir, "ownerless-old");
  const youngProfile = profileFolder(dir, "ownerless-young");
  const kill = recorder();
  await reapOrphans({
    tmpDir: dir,
    listProcesses: () => [
      { pid: 4001, cmd: cmdFor(oldProfile) },
      { pid: 4002, cmd: cmdFor(youngProfile) },
    ],
    kill,
    isAlive: () => false,
    queryStart: (pid) => (pid === 4001 ? Date.now() - OLD : Date.now() - 60_000),
  });
  assert.deepEqual(kill.calls[0].pids, [4001]);
});

test("row 3: an unparseable owner reads as absent and follows the grace", async (t) => {
  const dir = tempRoot(t);
  const profile = profileFolder(dir, "torn-owner");
  writeFileSync(join(profile, OWNER_FILE), "{not json");
  const kill = recorder();
  await reapOrphans({
    tmpDir: dir,
    listProcesses: () => [{ pid: 4001, cmd: cmdFor(profile, "brave.exe") }],
    kill,
    isAlive: () => true,
    queryStart: (pid) => (pid === 4001 ? Date.now() - OLD : null),
  });
  assert.deepEqual(kill.calls[0].pids, [4001]);
});

test("row 3: a renderer child is never the PID that is stopped", async (t) => {
  const dir = tempRoot(t);
  const profile = profileFolder(dir, "renderer");
  writeOwnerFile(profile, { pid: 9001, startMs: 1_000 });
  const kill = recorder();
  await reapOrphans({
    tmpDir: dir,
    listProcesses: () => [
      { pid: 4001, cmd: cmdFor(profile) },
      { pid: 4002, cmd: `${cmdFor(profile)} --type=renderer` },
    ],
    kill,
    isAlive: () => false,
    queryStart: () => null,
  });
  assert.deepEqual(kill.calls[0].pids, [4001]);
});

// --- rows 4, 5: foreign profiles and the sweep --------------------------------

test("row 4: a profile outside tmpDir is never touched, whatever its name", async (t) => {
  const dir = tempRoot(t);
  const decoy = profileFolder(dir, "decoy");
  writeOwnerFile(decoy, { pid: 9001, startMs: 1_000 }); // dead: the pre-scan must not skip
  const foreign = join(tmpdir(), "..", `${PROFILE_PREFIX}foreign`);
  const operatorProfile = join(tmpdir(), "Google", "Chrome", "User Data");
  const kill = recorder();
  await reapOrphans({
    tmpDir: dir,
    listProcesses: () => [
      { pid: 5001, cmd: cmdFor(foreign) },
      { pid: 5002, cmd: `chrome.exe --user-data-dir="${operatorProfile}"` },
      { pid: 5003, cmd: `chrome.exe --user-data-dir="${join(dir, "not-a-probe")}"` },
    ],
    kill,
    isAlive: () => false,
    queryStart: (pid) => (pid >= 5000 ? Date.now() - OLD : null),
  });
  assert.deepEqual(kill.calls, []);
});

test("row 5: the sweep removes old unheld profiles and keeps young and held ones", (t) => {
  const dir = tempRoot(t);
  const old = profileFolder(dir, "old");
  const young = profileFolder(dir, "young");
  const held = profileFolder(dir, "held");
  aged(old);
  aged(held);
  const result = sweepProfiles({ tmpDir: dir, liveProfiles: [held] });
  assert.deepEqual(result.removed, [old]);
  assert.equal(existsSync(old), false);
  assert.ok(existsSync(young));
  assert.ok(existsSync(held));
});

test("row 5: a listing that failed or cannot be parsed skips the sweep", async (t) => {
  const dir = tempRoot(t);
  const held = profileFolder(dir, "held-on-failure");
  aged(held);
  const base = { tmpDir: dir, kill: recorder(), isAlive: () => false, queryStart: () => null };
  for (const listProcesses of [() => { throw new Error("no process lister"); }, () => "not a list"]) {
    const result = await reapOrphans({ ...base, listProcesses });
    assert.equal(result.skipped, "listing-failed");
    assert.ok(existsSync(held), "a held profile survives a listing that could not answer");
  }
});

// --- row 8: batched kills -----------------------------------------------------

test("row 8: N orphans reach one Stop-Process invocation on Windows", () => {
  const calls = [];
  const pids = Array.from({ length: 19 }, (_, i) => 100 + i);
  const result = killPids(pids, {
    platform: "win32",
    _spawnSync: (exe, args, options) => {
      calls.push({ exe, args, options });
      return { status: 0 };
    },
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].exe, "pwsh");
  assert.match(calls[0].args[3], /Stop-Process -Id 100,101,/);
  assert.equal(calls[0].options.stdio, "ignore");
  assert.deepEqual(result.killed, pids);
});

test("row 8: the 19-browser reap batches its kill and stays inside the budget", async (t) => {
  const dir = tempRoot(t);
  const processes = [];
  for (let i = 0; i < 19; i++) {
    const profile = profileFolder(dir, `many-${i}`);
    writeOwnerFile(profile, { pid: 7000 + i, startMs: 1_000 });
    processes.push({ pid: 4000 + i, cmd: cmdFor(profile) });
  }
  const kill = recorder();
  const started = Date.now();
  const result = await reapOrphans({
    tmpDir: dir,
    listProcesses: () => processes,
    kill,
    isAlive: () => false,
    queryStart: () => null,
    timeoutMs: 5000,
  });
  assert.equal(kill.calls.length, 1);
  assert.equal(kill.calls[0].pids.length, 19);
  assert.equal(result.killed.length, 19);
  assert.ok(Date.now() - started < 5000);
  assert.ok(result.elapsedMs < 5000);
});

test("row 8: elsewhere the kill is one loop over the same PIDs", () => {
  const killed = [];
  killPids([21, 21, 22, 0, -1, 1.5], { platform: "linux", _kill: (pid, signal) => killed.push([pid, signal]) });
  assert.deepEqual(killed, [[21, "SIGKILL"], [22, "SIGKILL"]]);
});

// --- row 9: the pre-scan ------------------------------------------------------

test("row 9: a clean pre-scan never reaches the lister", async (t) => {
  const owned = tempRoot(t);
  const profile = profileFolder(owned, "owned");
  writeOwnerFile(profile, { pid: 9001, startMs: 1_000 });
  const empty = tempRoot(t);
  let listed = 0;
  const base = {
    listProcesses: () => { listed += 1; return []; },
    kill: recorder(),
    isAlive: (pid) => pid === 9001,
    queryStart: () => 1_000,
  };
  assert.equal((await reapOrphans({ ...base, tmpDir: owned })).skipped, "prescan");
  assert.equal((await reapOrphans({ ...base, tmpDir: empty })).skipped, "prescan");
  assert.equal(listed, 0);
  assert.equal(preScanProfiles({ tmpDir: owned }).reason, "owned");
  assert.equal(preScanProfiles({ tmpDir: empty }).reason, "clean");
});

test("row 9: one stale folder opens the gate to the lister", async (t) => {
  const dir = tempRoot(t);
  const profile = profileFolder(dir, "stale");
  writeOwnerFile(profile, { pid: 9001, startMs: 1_000 });
  aged(profile);
  let listed = 0;
  await reapOrphans({
    tmpDir: dir,
    listProcesses: () => { listed += 1; return []; },
    kill: recorder(),
    isAlive: () => true,
    queryStart: () => 1_000,
  });
  assert.equal(listed, 1);
});

// --- listers and the owner-liveness query -------------------------------------

test("the Windows lister parses both CIM shapes and refuses what it cannot read", () => {
  const one = listProcessesWindows({
    _spawnSync: (exe, args) => {
      assert.equal(exe, "pwsh");
      assert.match(args[3], /Get-CimInstance Win32_Process/);
      assert.match(args[3], /ui-probe-profile-/);
      return { status: 0, stdout: JSON.stringify({ ProcessId: 12, CommandLine: cmdFor("x") }) };
    },
  });
  assert.deepEqual(one, [{ pid: 12, cmd: cmdFor("x") }]);
  const many = listProcessesWindows({
    _spawnSync: () => ({
      status: 0,
      stdout: JSON.stringify([{ ProcessId: 1, CommandLine: "a" }, { ProcessId: 2, CommandLine: null }]),
    }),
  });
  assert.deepEqual(many, [{ pid: 1, cmd: "a" }, { pid: 2, cmd: "" }]);
  assert.deepEqual(listProcessesWindows({ _spawnSync: () => ({ status: 0, stdout: "" }) }), []);
  // A command line carrying a raw control character is not valid JSON text, but it is still a
  // listing: refusing it would disable the reaper on any machine that has such a process.
  const control = listProcessesWindows({
    _spawnSync: () => ({ status: 0, stdout: '[{"ProcessId":3,"CommandLine":"x\u001ay"}]' }),
  });
  assert.deepEqual(control, [{ pid: 3, cmd: "x y" }]);
  assert.throws(
    () => listProcessesWindows({ _spawnSync: () => ({ status: 0, stdout: "not json" }) }),
    /could not parse the process listing/,
  );
  assert.throws(() => listProcessesWindows({ _spawnSync: () => ({ status: 1, stdout: "" }) }), /exited 1/);
});

test("the Windows lister falls back to powershell only when pwsh is absent", () => {
  const seen = [];
  listProcessesWindows({
    _spawnSync: (exe) => {
      seen.push(exe);
      if (exe === "pwsh") return { error: Object.assign(new Error("absent"), { code: "ENOENT" }) };
      return { status: 0, stdout: "" };
    },
  });
  assert.deepEqual(seen, ["pwsh", "powershell"]);
});

test("the POSIX lister parses ps output and refuses a listing it cannot read", () => {
  const stdout = "  PID COMMAND\n   42 msedge --user-data-dir=/tmp/ui-probe-profile-a\n   43 chrome";
  assert.deepEqual(listProcessesPosix({ _spawnSync: () => ({ status: 0, stdout }) }), [
    { pid: 42, cmd: "msedge --user-data-dir=/tmp/ui-probe-profile-a" },
    { pid: 43, cmd: "chrome" },
  ]);
  assert.deepEqual(listProcessesPosix({ _spawnSync: () => ({ status: 0, stdout: "" }) }), []);
  assert.throws(
    () => listProcessesPosix({ _spawnSync: () => ({ status: 0, stdout: "garbage\n" }) }),
    /could not parse the process listing/,
  );
  assert.throws(() => listProcessesPosix({ _spawnSync: () => ({ status: 1, stdout: "" }) }), /exited 1/);
});

test("the owner-liveness query reads the OS start time or returns unknown", () => {
  const iso = "2026-11-16T10:00:00.0000000Z";
  const windows = queryProcessStart(456, {
    platform: "win32",
    _spawnSync: (exe, args) => {
      assert.equal(exe, "pwsh");
      assert.match(args[3], /ProcessId=456/);
      assert.match(args[3], /CreationDate/);
      return { status: 0, stdout: `${iso}\n` };
    },
  });
  assert.equal(windows, Date.parse(iso));
  const linux = queryProcessStart(789, {
    platform: "linux",
    _spawnSync: (exe, args) => {
      assert.equal(exe, "ps");
      assert.deepEqual(args, ["-o", "lstart=", "-p", "789"]);
      return { status: 0, stdout: "Sun Nov 16 10:00:00 2026\n" };
    },
  });
  assert.equal(linux, Date.parse("Sun Nov 16 10:00:00 2026"));
  assert.equal(queryProcessStart(1, { platform: "linux", _spawnSync: () => ({ status: 1 }) }), null);
  assert.equal(queryProcessStart(1, { platform: "win32", _spawnSync: () => ({ status: 0, stdout: "" }) }), null);
  assert.equal(queryProcessStart(0, { platform: "linux", _spawnSync: () => { throw new Error("must not run"); } }), null);
});

// --- owner file helpers -------------------------------------------------------

test("the owner file is written to a temp name, renamed, and reads back", (t) => {
  const profile = profileFolder(tempRoot(t), "owner");
  assert.equal(readOwnerFile(profile), null);
  const file = writeOwnerFile(profile, { pid: 4242, startMs: 1234 });
  assert.deepEqual(readOwnerFile(profile), { pid: 4242, startMs: 1234 });
  assert.equal(existsSync(`${file}.tmp`), false);
  assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), { pid: 4242, startMs: 1234 });
  const ops = [];
  writeOwnerFile(profile, {
    pid: 1,
    startMs: 2,
    fs: {
      writeFileSync: (path) => ops.push(["write", path]),
      renameSync: (from, to) => ops.push(["rename", from, to]),
    },
  });
  assert.deepEqual(ops.map(([op]) => op), ["write", "rename"]);
  assert.ok(ops[0][1].endsWith(".tmp") && ops[1][2].endsWith(OWNER_FILE));
});

test("a missing or malformed owner file reads as no owner", (t) => {
  const profile = profileFolder(tempRoot(t), "malformed");
  assert.equal(readOwnerFile(profile), null);
  for (const body of ["{not json", JSON.stringify({ pid: "x", startMs: 1 }), JSON.stringify({ pid: 5 })]) {
    writeFileSync(join(profile, OWNER_FILE), body);
    assert.equal(readOwnerFile(profile), null);
  }
  assert.equal(ownerStartMs(10_000, 2.4), 7_600);
});

test("only a direct child of tmpDir named with our prefix is our profile", (t) => {
  const dir = tempRoot(t);
  assert.equal(isUiProbeProfile(join(dir, `${PROFILE_PREFIX}a`), { tmpDir: dir }), true);
  assert.equal(isUiProbeProfile(join(dir, "other"), { tmpDir: dir }), false);
  assert.equal(isUiProbeProfile(join(dir, "nested", `${PROFILE_PREFIX}a`), { tmpDir: dir }), false);
  assert.equal(isUiProbeProfile(`${dir}${sep}..${sep}${PROFILE_PREFIX}escape`, { tmpDir: dir }), false);
  assert.equal(isUiProbeProfile(join(tmpdir(), "..", `${PROFILE_PREFIX}a`), { tmpDir: dir }), false);
  assert.equal(isUiProbeProfile("", { tmpDir: dir }), false);
});

// --- the error-path killer ----------------------------------------------------

test("the error-path killer stops the exact profile's root and stays quiet on failure", async () => {
  const profile = join(tmpdir(), `${PROFILE_PREFIX}kill-me`);
  const calls = [];
  const result = await killBrowserForProfile(profile, {
    platform: "linux",
    _list: () => [
      { pid: 31, cmd: cmdFor(profile) },
      { pid: 32, cmd: `${cmdFor(profile)} --type=renderer` },
      { pid: 33, cmd: cmdFor(`${profile}-other`) },
    ],
    _kill: (pids) => {
      calls.push(pids);
      return { killed: pids };
    },
  });
  assert.deepEqual(calls, [[31]]);
  assert.deepEqual(result.killed, [31]);
  const quiet = await killBrowserForProfile(profile, { _list: () => { throw new Error("no lister"); } });
  assert.deepEqual(quiet.killed, []);
});
