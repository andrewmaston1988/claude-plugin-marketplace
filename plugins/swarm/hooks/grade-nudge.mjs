#!/usr/bin/env node
// Stop hook: when grading is enabled, block the stop at every turn end if any
// finished run THIS session dispatched has no rows in the score store — the
// backstop for the grading ask the engine prints into the run's stdout, the
// one place a dispatching session never reads. Reports, never grades. A
// continuation stop (stop_hook_active) still exits silently, so one turn
// never loops — the next turn's stop asks again until the run is graded or
// waived. Also silent (exit 0) with no session id, when grading is disabled
// — before the store read or the runs walk happen — or on a malformed
// config: a hook must never break the stop.
import { pathToFileURL } from 'node:url';
import { loadConfig } from '../src/config.mjs';
import { readRows, scoresPath, gradedRunKeys } from '../src/scores.mjs';
import { decideGradeNudge, ungradedRuns } from '../src/grade-nudge.mjs';

async function main() {
  let stdin = '';
  process.stdin.setEncoding('utf8');
  for await (const c of process.stdin) stdin += c;
  let payload = {};
  try { payload = JSON.parse(stdin); } catch { process.exit(0); }
  if (payload.stop_hook_active) process.exit(0);
  const sessionId = String(payload.session_id || '');
  if (!sessionId) process.exit(0);

  // The gate comes before the expensive work: grading off means the 1.76MB
  // store and every run.log on disk are never touched.
  let config;
  try { config = loadConfig(undefined, process.env); } catch { process.exit(0); }
  if (config?.grading?.enabled !== true) process.exit(0);

  // The store and the runs walk, read fresh every stop — no once-marker to
  // short-circuit them (D3): the whole point is that this re-fires every turn.
  const heartbeatMs = Math.max(50, (config.heartbeatSecs ?? 15) * 1000);
  const graded = gradedRunKeys(readRows(scoresPath(process.env)));
  const decision = decideGradeNudge({
    config,
    runs: ungradedRuns({ env: process.env, graded, heartbeatMs }),
    graded,
    sessionId,
  });
  if (!decision.block) process.exit(0);

  process.stdout.write(JSON.stringify({ decision: 'block', reason: decision.reason }) + '\n');
  process.exit(0);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(() => process.exit(0));
}