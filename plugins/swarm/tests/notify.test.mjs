import test from "node:test";
import assert from "node:assert/strict";
import { createNotifier, notifyCommandLine, NOTIFY_SPAWN_OPTIONS } from "../src/notify.mjs";

function recordingSpawn() {
  const calls = [];
  const spawn = (cmd, opts) => { calls.push({ cmd, opts }); return { unref() {} }; };
  return { spawn, calls };
}

// N1. The defect the operator hit: a notifyCmd popped a PowerShell console window on
// every run. `detached: true` on Windows gives the child its own console unless
// windowsHide suppresses it. Reverting windowsHide out of NOTIFY_SPAWN_OPTIONS reddens
// this. Asserted on the options the notifier actually SPAWNS WITH, not on the constant,
// so a notifier that builds its own options object cannot pass it.
test("notify: the spawned options hide the console window", async () => {
  const { spawn, calls } = recordingSpawn();
  await createNotifier({ notifyCmd: "echo hi", _spawn: spawn })("done");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].opts.windowsHide, true,
    "a detached notify spawn without windowsHide opens a console window on Windows");
});

// N2. windowsHide must not arrive by dropping detached — an attached child dies with
// the run, which is the opposite of fire-and-forget.
test("notify: the spawn stays detached and silent", async () => {
  const { spawn, calls } = recordingSpawn();
  await createNotifier({ notifyCmd: "echo hi", _spawn: spawn })("done");
  assert.equal(calls[0].opts.detached, true);
  assert.equal(calls[0].opts.shell, true);
  assert.equal(calls[0].opts.stdio, "ignore");
});

// N3. Every other detached spawn in the plugin already hides its window; this pins the
// notify site to the same rule so it cannot drift back out on its own.
test("notify: NOTIFY_SPAWN_OPTIONS matches the daemon and tray spawns", () => {
  assert.equal(NOTIFY_SPAWN_OPTIONS.windowsHide, true);
  assert.equal(NOTIFY_SPAWN_OPTIONS.detached, true);
});

// N4. A caller must not be able to mutate the shared constant through a spawn.
test("notify: each spawn gets its own options object", async () => {
  const { spawn, calls } = recordingSpawn();
  const notify = createNotifier({ notifyCmd: "echo hi", _spawn: spawn });
  await notify("one");
  calls[0].opts.windowsHide = false;
  await notify("two");
  assert.equal(calls[1].opts.windowsHide, true);
  assert.equal(NOTIFY_SPAWN_OPTIONS.windowsHide, true);
});

test("notify: no notifyCmd spawns nothing", async () => {
  const { spawn, calls } = recordingSpawn();
  await createNotifier({ notifyCmd: "", _spawn: spawn })("done");
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
