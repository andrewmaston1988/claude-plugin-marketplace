// Test doubles for scheduler io — no network, no real claude.
import { EventEmitter } from "node:events";

// handler(call, index) -> { exit=0, output="", delayMs=1 } | undefined
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
    setTimeout(() => {
      if (done) return;
      if (spec.output) child.stdout.emit("data", spec.output);
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
  return {
    spawn,
    fetch: async () => ({ ok: true }),
    now: () => Date.now(),
    stdout: (line) => lines.push(line),
    env: { PATH: process.env.PATH },
    lines,
    ...over,
  };
}

// Extract the -p prompt from a recorded shim/fake call's argv.
export function promptOf(call) {
  const args = call.args ?? call.argv;
  const i = args.indexOf("-p");
  return i >= 0 ? args[i + 1] : undefined;
}
