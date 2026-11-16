// The process-facing half of the reaper: how it stops PIDs, reads the process
// listing and asks the OS when a process started. The ownership and sweep
// verdicts live in reaper.test.mjs.

import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  PROFILE_PREFIX,
  killBrowserForProfile,
  killPids,
  listProcessesPosix,
  listProcessesWindows,
  queryProcessStart,
  reapOrphans,
  writeOwnerFile,
} from "../src/reaper.mjs";
import { OLD, cmdFor, profileFolder, recorder, tempRoot } from "./reaper-support.mjs";

// --- row 8: batched kills -----------------------------------------------------

test("row 8: N orphans reach one Stop-Process invocation on Windows", async () => {
  const calls = [];
  const pids = Array.from({ length: 19 }, (_, i) => 100 + i);
  const result = await killPids(pids, {
    platform: "win32",
    _execFile: async (exe, args, options) => {
      calls.push({ exe, args, options });
      return { status: 0, stdout: "" };
    },
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].exe, "pwsh");
  assert.match(calls[0].args[3], /Stop-Process -Id \$ids/);
  assert.match(calls[0].args[3], /\$ids = @\(100,101,/);
  assert.match(calls[0].args[3], /Get-Process -Id/, "the same call reads the survivors back");
  assert.deepEqual(result.killed, pids);
  assert.deepEqual(result.failed, []);
});

test("row 8: a PID that survives the stop is reported failed, not killed", async () => {
  const result = await killPids([100, 101, 102], {
    platform: "win32",
    _execFile: async () => ({ stdout: "101\n" }),
  });
  assert.deepEqual(result.killed, [100, 102]);
  assert.deepEqual(result.failed, [101]);
});

test("row 8: a stop that cannot be verified claims no kills", async () => {
  const result = await killPids([100, 101], {
    platform: "win32",
    _execFile: async () => { throw Object.assign(new Error("pwsh exited 1"), { code: 1 }); },
  });
  assert.deepEqual(result.killed, []);
  assert.deepEqual(result.failed, [100, 101]);
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

test("row 8: elsewhere the kill is one loop over the same PIDs", async () => {
  const killed = [];
  const result = await killPids([21, 21, 22, 0, -1, 1.5], {
    platform: "linux",
    _kill: (pid, signal) => killed.push([pid, signal]),
    _alive: () => false,
  });
  assert.deepEqual(killed, [[21, "SIGKILL"], [22, "SIGKILL"]]);
  assert.deepEqual(result.killed, [21, 22]);
});

// --- listers and the owner-liveness query -------------------------------------

test("the Windows lister parses both CIM shapes and refuses what it cannot read", async () => {
  const one = await listProcessesWindows({
    _execFile: async (exe, args) => {
      assert.equal(exe, "pwsh");
      assert.match(args[3], /Get-CimInstance Win32_Process/);
      assert.match(args[3], /ui-probe-profile-/);
      return { stdout: JSON.stringify({ ProcessId: 12, CommandLine: cmdFor("x") }) };
    },
  });
  assert.deepEqual(one, [{ pid: 12, cmd: cmdFor("x") }]);
  const many = await listProcessesWindows({
    _execFile: async () => ({
      stdout: JSON.stringify([{ ProcessId: 1, CommandLine: "a" }, { ProcessId: 2, CommandLine: null }]),
    }),
  });
  assert.deepEqual(many, [{ pid: 1, cmd: "a" }, { pid: 2, cmd: "" }]);
  assert.deepEqual(await listProcessesWindows({ _execFile: async () => ({ stdout: "" }) }), []);
  // A command line carrying a raw control character is not valid JSON text, but it is still a
  // listing: refusing it would disable the reaper on any machine that has such a process.
  const control = await listProcessesWindows({
    _execFile: async () => ({ stdout: '[{"ProcessId":3,"CommandLine":"x\u001ay"}]' }),
  });
  assert.deepEqual(control, [{ pid: 3, cmd: "x y" }]);
  await assert.rejects(
    () => listProcessesWindows({ _execFile: async () => ({ stdout: "not json" }) }),
    /could not parse the process listing/,
  );
  await assert.rejects(
    () => listProcessesWindows({ _execFile: async () => { throw Object.assign(new Error("failed"), { code: 1 }); } }),
    /exited 1/,
  );
});

test("the Windows lister falls back to powershell only when pwsh is absent", async () => {
  const seen = [];
  await listProcessesWindows({
    _execFile: async (exe) => {
      seen.push(exe);
      if (exe === "pwsh") throw Object.assign(new Error("absent"), { code: "ENOENT" });
      return { stdout: "" };
    },
  });
  assert.deepEqual(seen, ["pwsh", "powershell"]);
});

test("the POSIX lister parses ps output and refuses a listing it cannot read", async () => {
  const stdout = "  PID COMMAND\n   42 msedge --user-data-dir=/tmp/ui-probe-profile-a\n   43 chrome";
  assert.deepEqual(await listProcessesPosix({ _execFile: async () => ({ stdout }) }), [
    { pid: 42, cmd: "msedge --user-data-dir=/tmp/ui-probe-profile-a" },
    { pid: 43, cmd: "chrome" },
  ]);
  assert.deepEqual(await listProcessesPosix({ _execFile: async () => ({ stdout: "" }) }), []);
  await assert.rejects(
    () => listProcessesPosix({ _execFile: async () => ({ stdout: "garbage\n" }) }),
    /could not parse the process listing/,
  );
  await assert.rejects(
    () => listProcessesPosix({ _execFile: async () => { throw new Error("ps failed"); } }),
    /ps failed/,
  );
});

test("the owner-liveness query reads the OS start time or returns unknown", async () => {
  const iso = "2026-11-16T10:00:00.0000000Z";
  const windows = await queryProcessStart(456, {
    platform: "win32",
    _execFile: async (exe, args) => {
      assert.equal(exe, "pwsh");
      assert.match(args[3], /ProcessId=456/);
      assert.match(args[3], /CreationDate/);
      return { stdout: `${iso}\n` };
    },
  });
  assert.equal(windows, Date.parse(iso));
  const linux = await queryProcessStart(789, {
    platform: "linux",
    _execFile: async (exe, args) => {
      assert.equal(exe, "ps");
      assert.deepEqual(args, ["-o", "lstart=", "-p", "789"]);
      return { stdout: "Sun Nov 16 10:00:00 2026\n" };
    },
  });
  assert.equal(linux, Date.parse("Sun Nov 16 10:00:00 2026"));
  const failed = async () => { throw new Error("ps exited 1"); };
  assert.equal(await queryProcessStart(1, { platform: "linux", _execFile: failed }), null);
  assert.equal(await queryProcessStart(1, { platform: "win32", _execFile: async () => ({ stdout: "" }) }), null);
  const never = async () => { throw new Error("must not run"); };
  assert.equal(await queryProcessStart(0, { platform: "linux", _execFile: never }), null);
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
