// The process-facing half of the reaper: how it stops PIDs, reads the process
// listing and asks the OS when a process started. The ownership and sweep
// verdicts live in reaper.test.mjs.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  PROFILE_PREFIX,
  killBrowserForProfile,
  killPids,
  listProcesses,
  listProcessesPosix,
  listProcessesWindows,
  profileFromCommandLine,
  queryProcessStart,
  queryProcessStarts,
  reapOrphans,
  writeOwnerFile,
} from "../src/reaper.mjs";
import { runPowerShell, survivorScript } from "../src/reaper-process.mjs";
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

// The generated script itself, not a fake stdout: an integer has no `.Id`, so any stage that
// projects one reads every survivor as killed.
test("row 8: the real read-back script names a survivor that was never stopped", { timeout: 60000 }, async (t) => {
  if (process.platform !== "win32") {
    t.skip("the generated script is PowerShell");
    return;
  }
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
  const exited = new Promise((done) => child.once("exit", done));
  t.after(async () => {
    child.kill();
    await exited;
  });
  const stdout = await runPowerShell(survivorScript([child.pid]), { timeoutMs: 20000 });
  assert.deepEqual(
    stdout.trim().split(/\s*,\s*/).filter(Boolean).map(Number),
    [child.pid],
    "a live PID reads back as its own integer",
  );
});

// The budget is enforced by launch(), not here; a timing assertion on rows with a fake
// lister and a recording killer passes whatever the clock does.
test("row 8: the 19-browser reap batches its kill into one invocation", async (t) => {
  const dir = tempRoot(t);
  const processes = [];
  for (let i = 0; i < 19; i++) {
    const profile = profileFolder(dir, `many-${i}`);
    writeOwnerFile(profile, { pid: 7000 + i, startMs: 1_000 });
    processes.push({ pid: 4000 + i, cmd: cmdFor(profile) });
  }
  const kill = recorder();
  const result = await reapOrphans({
    tmpDir: dir,
    listProcesses: () => processes,
    kill,
    isAlive: () => false,
    timeoutMs: 5000,
  });
  assert.equal(kill.calls.length, 1);
  assert.equal(kill.calls[0].pids.length, 19);
  assert.equal(result.killed.length, 19);
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

test("row 8: elsewhere a PID killed but not yet reaped settles instead of failing", async () => {
  // kill(pid, 0) still answers for a process the kernel has not reaped yet.
  const visibleFor = new Map([[21, 2], [22, 1]]);
  const result = await killPids([21, 22, 23], {
    platform: "linux",
    _kill: () => {},
    _alive: (pid) => {
      if (pid === 23) return true;
      const left = visibleFor.get(pid) ?? 0;
      if (left <= 0) return false;
      visibleFor.set(pid, left - 1);
      return true;
    },
    _sleep: async () => {},
  });
  assert.deepEqual(result.killed, [21, 22]);
  assert.deepEqual(result.failed, [23]);
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
  // One argv that renders across two lines must cost the listing one row, not every row.
  const wrapped = "  PID COMMAND\n   42 msedge --user-data-dir=/tmp/ui-probe-profile-a\n   continuation\n   43 chrome";
  assert.deepEqual(await listProcessesPosix({ _execFile: async () => ({ stdout: wrapped }) }), [
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

test("the batched start-time query answers every PID from one spawn", async () => {
  const iso = "2026-11-16T10:00:00.0000000Z";
  const seen = [];
  const windows = await queryProcessStarts([11, 12, 12, 0], {
    platform: "win32",
    _execFile: async (exe, args) => {
      seen.push(exe);
      assert.match(args[3], /ProcessId=11 or ProcessId=12/);
      return { stdout: JSON.stringify([{ ProcessId: 11, Start: iso }]) };
    },
  });
  assert.deepEqual(seen, ["pwsh"]);
  assert.equal(windows.get(11), Date.parse(iso));
  assert.equal(windows.get(12), null, "a PID the OS does not answer for is unknown");

  const posix = await queryProcessStarts([21, 22], {
    platform: "linux",
    _execFile: async (exe, args) => {
      assert.equal(exe, "ps");
      assert.deepEqual(args, ["-o", "pid=,lstart=", "-p", "21,22"]);
      return { stdout: "   21 Sun Nov 16 10:00:00 2026\n" };
    },
  });
  assert.equal(posix.get(21), Date.parse("Sun Nov 16 10:00:00 2026"));
  assert.equal(posix.get(22), null);

  const failed = await queryProcessStarts([31], {
    platform: "linux",
    _execFile: async () => { throw new Error("ps failed"); },
  });
  assert.equal(failed.get(31), null, "an unreadable answer is unknown, not a start time");
  const empty = await queryProcessStarts([], {
    platform: "linux",
    _execFile: async () => assert.fail("no ids, no spawn"),
  });
  assert.equal(empty.size, 0);
});

// --- the parser against a real spawn ------------------------------------------

async function listingFor(pid, deadlineMs = 20000) {
  const started = Date.now();
  for (;;) {
    const entry = (await listProcesses()).find((row) => row.pid === pid);
    if (entry) return entry;
    if (Date.now() - started >= deadlineMs) assert.fail(`pid ${pid} never appeared in the process listing`);
    await new Promise((done) => setTimeout(done, 200));
  }
}

test("profileFromCommandLine round-trips an argument the OS captured from a real spawn", { timeout: 60000 }, async (t) => {
  // Node quotes the whole argument only when it contains a space, so the fixture needs a
  // space in the path — the shape the ownership verdicts otherwise never see.
  const root = mkdtempSync(join(tmpdir(), "ui-probe fixture "));
  const profile = join(root, `${PROFILE_PREFIX}fixture`);
  mkdirSync(profile);
  // `--` keeps the fixture argument out of node's own option parsing; the OS still records it.
  const child = spawn(
    process.execPath,
    ["-e", "setInterval(() => {}, 1000)", "--", `--user-data-dir=${profile}`],
    { stdio: "ignore" },
  );
  const exited = new Promise((done) => child.once("exit", done));
  t.after(async () => {
    child.kill();
    await exited;
    rmSync(root, { recursive: true, force: true });
  });
  assert.match(profile, /\s/, "the fixture path contains a space");

  const entry = await listingFor(child.pid);
  if (process.platform === "win32") {
    assert.ok(entry.cmd.includes(`"--user-data-dir=${profile}"`), `the whole argument is quoted: ${entry.cmd}`);
  }
  assert.equal(profileFromCommandLine(entry.cmd), profile);
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
