// Test doubles for scheduler io — no network, no real claude.
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { withoutLeafNotices } from "../../src/leaf-notices.mjs";
import { writeUsageReading } from "../../src/usage-cache.mjs";

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
    // Mirror real ChildProcess: both null while alive, so the valve's
    // liveness check (exitCode/signalCode) has something real to read.
    child.exitCode = null;
    child.signalCode = null;
    let done = false;
    gauge.active++;
    gauge.max = Math.max(gauge.max, gauge.active);
    const close = (code, signal = null) => {
      if (done) return;
      done = true;
      gauge.active--;
      child.exitCode = signal ? null : code;
      child.signalCode = signal;
      child.emit("close", code);
    };
    child.kill = () => close(null, "SIGTERM");
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
    freeMemMb: () => Infinity,
    stdout: (line) => lines.push(line),
    snapshot: (block) => snapshots.push(block),
    // isolated SWARM_HOME so quota-cache reads/writes never touch the real one
    env: { PATH: process.env.PATH, SWARM_HOME: mkdtempSync(join(tmpdir(), "swarm-io-")) },
    lines,
    snapshots,
    ...over,
  };
}

// The reading a live codex read would have banked. `exhausted` is the field the
// preflight refuses on, so the healthy default is stated, never left absent.
export const codexReading = (over = {}) => ({
  provider: "codex",
  buckets: [{
    kind: "rate-limit",
    limitId: "codex",
    primary: { usedPercent: 3, windowDurationMins: 300, resetsAt: 4102444800 },
  }],
  source: "codex-app-server",
  provenance: "live",
  exhausted: false,
  ...over,
});

// An io.env whose SWARM_HOME already holds the readings. A provider preflight
// asks the cache before it spawns anything, so a seeded home keeps the test off
// the operator's real meter. Written through usage-cache.mjs so the envelope is
// the one the engine reads. Self-cleaning: the dir goes when the process does.
export function usageEnv(readings, { fetchedAt = Date.now() } = {}) {
  const home = mkdtempSync(join(tmpdir(), "swarm-usage-home-"));
  process.on("exit", () => {
    try { rmSync(home, { recursive: true, force: true }); } catch { /* best effort */ }
  });
  for (const [provider, result] of Object.entries(readings)) {
    writeUsageReading(provider, { fetchedAt, result }, { env: { SWARM_HOME: home } });
  }
  return { PATH: process.env.PATH, SWARM_HOME: home };
}

// The prompt a recorded call actually carried: claude rides `-p`, codex takes it
// positionally. Never strips — the engine's own notice is part of what was sent.
export function sentPrompt(call) {
  const args = call.args ?? call.argv;
  const i = args.indexOf("-p");
  return i >= 0 ? args[i + 1] : args[args.length - 1];
}

// The prompt the MANIFEST authored — the engine's trailing notice stripped, since
// every stub here discriminates on the authored text. Undefined on a call with no
// prompt of its own (codex's argv tail is not one).
export function promptOf(call) {
  const args = call.args ?? call.argv;
  return args.indexOf("-p") >= 0 ? withoutLeafNotices(sentPrompt(call)) : undefined;
}

// Every `--add-dir` value in a recorded (or constructed) argv, in emitted order.
export function addDirsOf(args) {
  return (args ?? []).reduce((acc, value, i) => (value === "--add-dir" ? [...acc, args[i + 1]] : acc), []);
}

// A canned claude stream-json transcript for a resumed ask: init on s-2, then the answer.
export const STREAM = [
  JSON.stringify({ type: "system", subtype: "init", session_id: "s-2" }),
  JSON.stringify({
    type: "result", subtype: "success", is_error: false, result: "the follow-up answer",
    usage: { input_tokens: 900, output_tokens: 80 },
  }),
].join("\n") + "\n";
