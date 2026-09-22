import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import {
  createNotifier, notifyCommandLine, splitCommand, windowsLaunchArgs, NOTIFY_SPAWN_OPTIONS,
} from "../src/notify.mjs";

function recordingSpawn() {
  const calls = [];
  const spawn = (cmd, argvOrOpts, maybeOpts) => {
    calls.push(maybeOpts ? { cmd, argv: argvOrOpts, opts: maybeOpts } : { cmd, opts: argvOrOpts });
    return { unref() {} };
  };
  return { spawn, calls };
}

const win = (cmd) => createNotifier({ notifyCmd: cmd, _platform: "win32", _spawn: recordingSpawn().spawn });

// N1. Windows needs BOTH halves and each is separately load-bearing, so each has its
// own row. `detached` alone survives but shows a console; dropping it hides the
// console by killing the child with the run, which notifies nobody; `start` alone
// gets a fresh console that is still shown. Only start + the target's own hidden
// flag gives a notification with no window.
test("notify: windows launches through cmd start, detached, with no console of its own", async () => {
  const { spawn: rec, calls } = recordingSpawn();
  await createNotifier({ notifyCmd: "powershell -WindowStyle Hidden -File n.ps1", _platform: "win32", _spawn: rec })("done");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].cmd, "cmd.exe");
  assert.deepEqual(calls[0].argv.slice(0, 4), ["/c", "start", "", "/min"],
    "start is what gives the child a console outside our job, so it outlives the run");
  assert.equal(calls[0].opts.detached, true, "without detached the child dies with the run and never notifies");
  assert.equal(calls[0].opts.shell, undefined,
    "shell:true would put cmd's own visible console in front of the target");
  assert.equal(calls[0].opts.stdio, "ignore");
  assert.equal(calls[0].opts.windowsHide, true);
});

// N2. The target's words go to `start` directly. Re-wrapping them in another
// `cmd.exe /c` was measured to produce a VISIBLE console: the wrapper gets its own,
// and the target's hidden-window flag then has nothing left to hide.
test("notify: the target is not re-wrapped in another cmd /c", async () => {
  const { spawn: rec, calls } = recordingSpawn();
  await createNotifier({ notifyCmd: "powershell -WindowStyle Hidden -File n.ps1", _platform: "win32", _spawn: rec })("done");
  const afterStart = calls[0].argv.slice(4);
  assert.equal(afterStart[0], "powershell",
    `start must hand off to the target itself, got ${JSON.stringify(afterStart.slice(0, 3))}`);
  assert.ok(!afterStart.includes("/c"), "a nested cmd /c re-shows the console");
});

// N3. A status with spaces must reach the target as ONE argument. splitCommand drops
// the quotes because each word is passed as its own argv entry and never re-parsed.
test("notify: a quoted token stays one argument after substitution", async () => {
  const { spawn: rec, calls } = recordingSpawn();
  await createNotifier({ notifyCmd: 'powershell -File n.ps1 -Status "{status}"', _platform: "win32", _spawn: rec })("run finished ok");
  assert.deepEqual(calls[0].argv.slice(-2), ["-Status", "run finished ok"]);
});

test("notify: splitCommand groups on double quotes and splits on whitespace", () => {
  assert.deepEqual(splitCommand('a "b c" d'), ["a", "b c", "d"]);
  assert.deepEqual(splitCommand("solo"), ["solo"]);
  assert.deepEqual(splitCommand(""), []);
});

test("notify: windowsLaunchArgs is the shape the tray uses", () => {
  assert.deepEqual(windowsLaunchArgs("prog -x"), ["/c", "start", "", "/min", "prog", "-x"]);
});

// N4. Non-Windows keeps the plain shell spawn — none of the console reasoning applies.
test("notify: posix spawns the command line through a shell, detached", async () => {
  const { spawn: rec, calls } = recordingSpawn();
  await createNotifier({ notifyCmd: "echo hi", _platform: "linux", _spawn: rec })("done");
  assert.equal(calls[0].cmd, "echo hi");
  assert.equal(calls[0].opts.shell, true);
  assert.equal(calls[0].opts.detached, true);
  assert.equal(calls[0].opts.stdio, "ignore");
});

test("notify: each posix spawn gets its own options object", async () => {
  const { spawn: rec, calls } = recordingSpawn();
  const notify = createNotifier({ notifyCmd: "echo hi", _platform: "linux", _spawn: rec });
  await notify("one");
  calls[0].opts.windowsHide = false;
  await notify("two");
  assert.equal(calls[1].opts.windowsHide, true);
  assert.equal(NOTIFY_SPAWN_OPTIONS.windowsHide, true);
});

test("notify: no notifyCmd spawns nothing", async () => {
  const { spawn: rec, calls } = recordingSpawn();
  await createNotifier({ notifyCmd: "", _spawn: rec })("done");
  assert.equal(calls.length, 0);
});

test("notify: a throwing spawn is swallowed — notification is garnish", async () => {
  const boom = () => { throw new Error("no such shell"); };
  await createNotifier({ notifyCmd: "echo hi", _spawn: boom })("done");
});

test("notify: all three tokens substitute", () => {
  const line = notifyCommandLine("n {status} {digest} {summary}", "ok",
    { digest: "d.md", summary: "s.json" });
  assert.equal(line, "n ok d.md s.json");
});

test("notify: absent digest and summary substitute empty, never the literal token", () => {
  assert.equal(notifyCommandLine("n {status} {digest} {summary}", "ok"), "n ok  ");
});

// N5. The end-to-end measurement, opt-in only. It spawns real processes and its
// control deliberately opens a console window, so running it on every suite put one
// on the operator's desktop each time. `SWARM_NOTIFY_CONSOLE_TEST=1` runs it; the
// unit rows above cover the shape in CI.
//
// It is written to be capable of failing: the control asserts the KNOWN-BAD options
// really do produce a visible console here, and the row skips rather than passes
// where the environment cannot tell the two states apart.
const consoleRow = {
  skip: process.platform !== "win32" ? "windows-only console semantics"
    : process.env.SWARM_NOTIFY_CONSOLE_TEST !== "1" ? "opt-in: SWARM_NOTIFY_CONSOLE_TEST=1 (spawns real windows)"
    : false,
};

test("notify: the real launch leaves no visible console and still runs", consoleRow, async (t) => {
  const probe = fileURLToPath(new URL("./fixtures/report-console.ps1", import.meta.url));
  const dir = mkdtempSync(join(tmpdir(), "swarm-notify-"));
  const wait = async (out) => {
    for (let i = 0; i < 80 && !existsSync(out); i++) await setTimeout(250);
    return existsSync(out) ? readFileSync(out, "utf8").trim() : null;
  };

  const out = join(dir, "actual.txt");
  const line = `powershell -WindowStyle Hidden -NoProfile -ExecutionPolicy Bypass -File "${probe}" -Out "${out}"`;
  spawn("cmd.exe", windowsLaunchArgs(line), { detached: true, stdio: "ignore", windowsHide: true }).unref();
  const actual = await wait(out);

  assert.ok(actual !== null, "the notify launch must outlive this process and run the child");
  if (/hwnd=0 |visible=False/.test(actual)) return;

  const ctl = join(dir, "control.txt");
  spawn(`powershell -NoProfile -ExecutionPolicy Bypass -File "${probe}" -Out "${ctl}"`,
    { shell: true, detached: true, stdio: "ignore", windowsHide: true }).unref();
  const control = await wait(ctl);
  if (control === null || !control.includes("visible=True")) {
    return t.skip(`cannot distinguish console states here (control read ${control})`);
  }
  assert.fail(`notify launched a child owning a visible console (${actual})`);
});
