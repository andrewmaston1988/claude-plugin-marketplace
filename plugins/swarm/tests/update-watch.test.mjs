// Tests for the update watcher (plan dashboard-launch-path, tests 3-5). The
// spawner, the registry resolve, the clock and fs.watch are all injected —
// nothing here ever re-execs, spawns, or waits on a real timer.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { startUpdateWatch, defaultSpawnReplacement } from "../src/serve/update-watch.mjs";

const REGISTRY_NAME = "installed_plugins.json";

// A fake timer queue: the watcher's debounce runs only when the test fires it.
const fakeTimers = () => {
  const pending = new Map();
  let id = 0;
  return {
    setTimeout: (fn, ms) => { const k = ++id; pending.set(k, { fn, ms }); return k; },
    clearTimeout: (k) => pending.delete(k),
    size: () => pending.size,
    async run(max = 20) {
      for (let i = 0; i < max && pending.size; i++) {
        const [k, { fn }] = [...pending.entries()][0];
        pending.delete(k);
        fn();
        await new Promise((r) => setTimeout(r, 0)); // let the async check settle
      }
    },
  };
};

// A fake fs.watch: the test holds the emit() end of the wire.
const fakeWatch = () => {
  const h = { fn: null, closed: 0 };
  h.watch = (dir, fn) => { h.fn = fn; return { close: () => { h.fn = null; h.closed++; } }; };
  h.emit = (event, filename) => { if (h.fn) h.fn(event, filename); };
  return h;
};

// One watcher under test: a temp registry path, a mutable "installed version",
// spies for every side effect, all injected.
const setup = (over = {}) => {
  const dir = mkdtempSync(join(tmpdir(), "swarm-watch-"));
  const registry = join(dir, REGISTRY_NAME);
  const installedBox = { v: "v1" }; // what `resolve` reports as installed
  const timers = fakeTimers();
  const watch = fakeWatch();
  const calls = { spawn: [], order: [], prepare: 0, retake: 0, exit: 0, onStale: [], log: [] };
  const innerSpawn = over.spawnReplacement ?? (async () => ({ ok: true, pid: 555 }));
  const innerConfirm = over.confirm ?? (async () => ({ ok: true, record: { pid: 555, listening: true } }));
  const handle = startUpdateWatch({
    registryPath: registry,
    own: { pid: 111, port: 7331, version: "v1", startedMs: 0 },
    shimPath: "C:\\Users\\a\\.swarm\\serve.mjs",
    resolve: () => ({ installPath: "/new", version: installedBox.v }),
    prepare: async () => { calls.prepare++; calls.order.push("prepare"); },
    retake: async () => { calls.retake++; calls.order.push("retake"); },
    spawnReplacement: async (argv) => { calls.spawn.push(argv); calls.order.push("spawn"); return innerSpawn(argv); },
    confirm: async () => { calls.order.push("confirm"); return innerConfirm(); },
    exit: () => { calls.exit++; },
    onStale: (inst) => { calls.onStale.push(inst); },
    log: (msg) => { calls.log.push(msg); },
    watch: watch.watch,
    setTimeout: timers.setTimeout, clearTimeout: timers.clearTimeout,
    ...over.args,
  });
  return { dir, registry, installedBox, timers, watch, calls, handle };
};

test("update watcher: re-execs exactly once per version move, through the shim, after the port is released", async () => {
  const s = setup();
  try {
    // A registry event with no version move is noise — the version is the
    // signal, not the file's mtime.
    s.watch.emit("change", REGISTRY_NAME);
    s.watch.emit("rename", REGISTRY_NAME);
    await s.timers.run();
    assert.equal(s.calls.spawn.length, 0, "a registry event with no version change must not re-exec");
    assert.equal(s.calls.prepare, 0, "the port is not released for noise");

    s.installedBox.v = "v2";
    s.watch.emit("change", REGISTRY_NAME);
    await s.timers.run();
    assert.equal(s.calls.spawn.length, 1, "a version move re-execs exactly once");
    assert.deepEqual(s.calls.spawn[0], [process.execPath, "C:\\Users\\a\\.swarm\\serve.mjs", "scripts/swarm.mjs", "serve"],
      "argv: the stable shim running FOREGROUND serve — never the sha-versioned cache path, never a second --daemon");
    assert.ok(!/plugins[\\/]cache/.test(s.calls.spawn[0].join(" ")), "the plugin cache path must never appear in the argv");
    assert.deepEqual(s.calls.order.filter((x) => x === "prepare" || x === "spawn" || x === "confirm"),
      ["prepare", "spawn", "confirm"], "the port is released BEFORE the replacement is spawned — the reverse order deadlocks the handover");
    assert.equal(s.calls.exit, 1, "the old daemon exits once the replacement is confirmed listening");

    s.watch.emit("change", REGISTRY_NAME); // after exit: no further spawns
    await s.timers.run();
    assert.equal(s.calls.spawn.length, 1);
    s.handle.stop();
  } finally { rmSync(s.dir, { recursive: true, force: true }); }
});

test("update watcher: events inside the debounce window coalesce into one re-exec", async () => {
  const s = setup();
  try {
    s.watch.emit("change", "unrelated.json"); // other files in the dir are not the registry
    assert.equal(s.timers.size(), 0, "an event for a different file arms nothing");
    s.installedBox.v = "v2";
    s.watch.emit("change", REGISTRY_NAME);
    s.watch.emit("change", REGISTRY_NAME);
    s.watch.emit("rename", REGISTRY_NAME);
    assert.equal(s.timers.size(), 1, "three rapid events arm one debounce timer, not three");
    await s.timers.run();
    assert.equal(s.calls.spawn.length, 1, "three events in the window → one re-exec");
    s.handle.stop();
  } finally { rmSync(s.dir, { recursive: true, force: true }); }
});

test("update watcher: autoRestartOnUpdate=false reports the mismatch once per version and never spawns", async () => {
  const s = setup({ args: { autoRestart: false } });
  try {
    s.installedBox.v = "v2";
    s.watch.emit("change", REGISTRY_NAME);
    await s.timers.run();
    assert.equal(s.calls.spawn.length, 0, "the key off means no re-exec, ever");
    assert.equal(s.calls.prepare, 0, "the port is never released");
    assert.equal(s.calls.exit, 0);
    assert.equal(s.calls.onStale.length, 1, "the mismatch is reported — the off switch is not the watcher's");
    assert.ok(s.calls.log.some((l) => /autoRestartOnUpdate is false/.test(l)), "the report names the off switch and the remedy");
    assert.ok(s.calls.log.some((l) => /swarm serve restart/.test(l)), "the report names the manual remedy");

    s.watch.emit("change", REGISTRY_NAME); // the same version landing again is not news
    await s.timers.run();
    assert.equal(s.calls.onStale.length, 1, "one report per distinct version");

    s.installedBox.v = "v3"; // a genuinely new version is news again
    s.watch.emit("change", REGISTRY_NAME);
    await s.timers.run();
    assert.equal(s.calls.onStale.length, 2);
    assert.equal(s.calls.spawn.length, 0);
    s.handle.stop();
  } finally { rmSync(s.dir, { recursive: true, force: true }); }
});

test("update watcher: a failed replacement leaves the old daemon up — retake, no exit, no retry loop", async () => {
  // THE test: a naive spawn-then-exit kills the dashboard exactly here. The
  // assertions are ordered so the first to fail is the one that names the
  // way the dashboard died.
  const s = setup({ spawnReplacement: async () => ({ ok: false, reason: "spawn ENOENT" }) });
  try {
    s.installedBox.v = "v2";
    s.watch.emit("change", REGISTRY_NAME);
    await s.timers.run();
    assert.equal(s.calls.prepare, 1, "the port was released for the attempt");
    // Exactly one: a bound (>= 1) is passed by a multi-retake implementation too,
    // and a daemon thrashing the port is a defect this test should catch.
    assert.equal(s.calls.retake, 1, "the old daemon retakes the port exactly once");
    assert.equal(s.calls.exit, 0, "a failed replacement must NOT exit the old daemon");
    assert.ok(s.calls.log.some((l) => /failed to start/.test(l)), "the failure is logged");
    assert.ok(!s.calls.order.includes("confirm"), "no confirm wait for a spawn that never happened");

    s.watch.emit("change", REGISTRY_NAME); // the same version again is not a retry loop
    await s.timers.run();
    assert.equal(s.calls.spawn.length, 1, "baseline moved past the bad version — one failed handover, not a loop");
    assert.equal(s.calls.exit, 0);
    s.handle.stop();
  } finally { rmSync(s.dir, { recursive: true, force: true }); }
});

test("update watcher: a replacement that never comes up hands the port back to the old daemon", async () => {
  const s = setup({ confirm: async () => ({ ok: false, reason: "timed out after 20000ms waiting for a listening daemon" }) });
  try {
    s.installedBox.v = "v2";
    s.watch.emit("change", REGISTRY_NAME);
    await s.timers.run();
    assert.equal(s.calls.exit, 0, "an UNCONFIRMED replacement must not exit the old daemon");
    assert.equal(s.calls.retake, 1, "the old daemon retakes the port and keeps serving");
    assert.ok(s.calls.log.some((l) => /did not come up/.test(l)), "the failure is logged");
    s.watch.emit("change", REGISTRY_NAME);
    await s.timers.run();
    assert.equal(s.calls.spawn.length, 1, "no retry loop on the same version");
    s.handle.stop();
  } finally { rmSync(s.dir, { recursive: true, force: true }); }
});

test("update watcher: defaultSpawnReplacement (D4a) goes through spawnLoggedDaemon -- real fds, not stdio: \"ignore\"", async () => {
  const home = mkdtempSync(join(tmpdir(), "swarm-watch-spawn-"));
  try {
    const calls = [];
    const _spawn = (cmd, args, opts) => {
      calls.push({ cmd, args, opts });
      return { pid: 4242, unref: () => {} };
    };
    const _openSync = () => 99; // a fake fd -- proof the log path went through openSync, not "ignore"
    const closed = [];
    const _closeSync = (fd) => { closed.push(fd); };
    const res = await defaultSpawnReplacement([process.execPath, "C:\\s\\serve.mjs", "scripts/swarm.mjs", "serve"], home, { _spawn, _openSync, _closeSync });
    assert.deepEqual(res, { ok: true, pid: 4242 });
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0].opts.stdio, ["ignore", 99, 99], "stdout/stderr must be real fds so a crash before the replacement's own pid write still leaves a stack trace, never stdio: \"ignore\"");
    assert.equal(calls[0].opts.detached, true);
    // The long-lived daemon runs this on every handover attempt: the parent's copy
    // of the fd must be closed, or each failed attempt leaks one (code review dash-cr-1).
    assert.deepEqual(closed, [99], "the parent closes its log fd after the spawn");
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test("update watcher: an unwatchable registry dir falls back to slow polling; stop() disarms everything", async () => {
  const timers = fakeTimers();
  const logs = [];
  const handle = startUpdateWatch({
    registryPath: "Z:\\absent\\dir\\installed_plugins.json",
    own: { pid: 1, version: "v1" },
    shimPath: "C:\\s\\serve.mjs",
    prepare: async () => {},
    retake: async () => {},
    watch: () => { throw new Error("EPERM"); },
    resolve: () => ({ version: "v2" }),
    spawnReplacement: async () => ({ ok: true, pid: 9 }), // never reached: no timer fires before stop()
    exit: () => { throw new Error("must not exit in this test"); },
    log: (m) => logs.push(m),
    setTimeout: timers.setTimeout, clearTimeout: timers.clearTimeout,
  });
  assert.ok(logs.some((l) => /checking every 5000ms/.test(l)), "the fallback is named in the log");
  assert.ok(timers.size() >= 1, "a slow-poll timer is armed");
  handle.stop();
  assert.equal(timers.size(), 0, "stop() clears the poll");
});