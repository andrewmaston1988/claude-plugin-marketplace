// Test doubles for scheduler io — no network, no real claude.
import { EventEmitter } from "node:events";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// handler(call, index) -> { exit=0, output="", delayMs=1, outputAtMs? } | undefined
// outputAtMs emits output early (before close at delayMs) so tests can observe
// mid-run state like the activity cell.
export function fakeSpawnFactory(handler = () => ({})) {
  const calls = [];
  const gauge = { active: 0, max: 0 };
  function spawn(cmd, args, opts) {
    const call = { cmd, args, opts, startedAt: Date.now() };
    calls.push(call);
    const spec = handler(call, calls.length - 1) || {};
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    let done = false;
    gauge.active++;
    gauge.max = Math.max(gauge.max, gauge.active);
    const close = (code) => {
      if (done) return;
      done = true;
      gauge.active--;
      child.emit("close", code);
    };
    child.kill = () => close(null);
    let emitted = false;
    if (spec.outputAtMs != null) {
      setTimeout(() => {
        if (done || emitted) return;
        emitted = true;
        if (spec.output) child.stdout.emit("data", spec.output);
      }, spec.outputAtMs);
    }
    setTimeout(() => {
      if (done) return;
      if (spec.output && !emitted) child.stdout.emit("data", spec.output);
      close(spec.exit ?? 0);
    }, spec.delayMs ?? 1);
    return child;
  }
  spawn.calls = calls;
  spawn.gauge = gauge;
  return spawn;
}

export function makeIo(spawn, over = {}) {
  const lines = [];
  const snapshots = [];
  return {
    spawn,
    fetch: async () => ({ ok: true }),
    now: () => Date.now(),
    stdout: (line) => lines.push(line),
    snapshot: (block) => snapshots.push(block),
    // isolated SWARM_HOME so quota-cache reads/writes never touch the real one
    env: { PATH: process.env.PATH, SWARM_HOME: mkdtempSync(join(tmpdir(), "swarm-io-")) },
    lines,
    snapshots,
    ...over,
  };
}

// Extract the -p prompt from a recorded shim/fake call's argv.
export function promptOf(call) {
  const args = call.args ?? call.argv;
  const i = args.indexOf("-p");
  return i >= 0 ? args[i + 1] : undefined;
}
