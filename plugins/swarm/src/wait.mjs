// `swarm wait <resultsDir>` — block until a run settles, then hand back one
// completion notice.
//
// A run is normally noticed by the background shell finishing. When the host
// reaps that wrapper (low memory) the engine keeps running and the session is
// left blind: no notice ever arrives. This polls the SAME readRun the status
// view uses and exits on the same signals — a terminal summary, or a heartbeat
// gone quiet.
import { join, resolve } from "node:path";
import { readRun } from "./runlog.mjs";
import { renderRun } from "./results.mjs";

// The exit codes are the contract: 0 every leaf settled clean, 1 something did
// not, 2 the engine died before it settled anything.
export const EXIT_CLEAN = 0;
export const EXIT_FAILED = 1;
export const EXIT_DEAD = 2;

const defaultSleep = (ms) => new Promise((r) => setTimeout(r, ms));

// The same rows renderRun puts on the roster, so the verdict and the printed
// view can never disagree about which leaves were counted.
const leavesOf = (run) => run.tasks.filter((t) => t.kind !== "agentless" || t.lastEventMs != null);

export function settledCode(run) {
  const unsettled = leavesOf(run).filter((t) => t.state !== "ok" && t.state !== "skipped");
  return unsettled.length ? EXIT_FAILED : EXIT_CLEAN;
}

// The subcommand itself. The CLI owns argv and hands its own writers in, so
// stdout keeps one contract and the exit code stays the whole result.
export async function runWaitCommand(dir, { quietWarnSecs = 60, out, err, ...opts } = {}) {
  const r = await waitForRun(dir, { quietWarnMs: quietWarnSecs * 1000, ...opts });
  if (r.message) err(r.message);
  if (r.roster) out(r.roster);
  return r.code;
}

export async function waitForRun(dir, {
  read = readRun,
  render = renderRun,
  sleep = defaultSleep,
  now = Date.now,
  intervalMs = 5000,
  quietWarnMs = 60_000,
  heartbeatMs = 15_000,
  aliveGraceMs = 30_000,
} = {}) {
  const abs = resolve(dir);
  for (;;) {
    const at = now();
    const run = read(abs, { now: at, quietWarnMs, heartbeatMs });
    if (!run) {
      return {
        code: EXIT_FAILED,
        run: null,
        message: `swarm: no run.log at ${join(abs, "run.log")} — pass the absolute resultsDir printed at dispatch.`,
      };
    }
    // readRun falls back to run.log's own mtime when no heartbeat exists yet,
    // which is true of every run's first seconds — so an engine that has not had
    // time to tick is starting, not dead.
    const dead = run.abortedMs != null && at - run.abortedMs >= aliveGraceMs;
    if (dead || run.finishedMs != null || run.stoppedMs != null) {
      return {
        code: dead ? EXIT_DEAD : settledCode(run),
        run,
        roster: render(run, { now: at, quietWarnMs }),
      };
    }
    await sleep(intervalMs);
  }
}
