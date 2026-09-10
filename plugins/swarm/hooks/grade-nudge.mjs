#!/usr/bin/env node
// Stop hook: when grading is enabled, block the stop once per session if any
// run THIS session dispatched has no rows in the score store — the backstop
// for the grading ask the engine prints into the run's stdout, the one place a
// dispatching session never reads. Reports, never grades. Silent (exit 0) on a
// continuation stop (stop_hook_active), with no session id, when grading is
// disabled — before the store read or the runs walk happen — or on a
// malformed config: a hook must never break the stop.
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadConfig, swarmHome } from '../src/config.mjs';
import { readRows, scoresPath, gradedRunKeys } from '../src/scores.mjs';
import { decideGradeNudge, ungradedRuns } from '../src/grade-nudge.mjs';

// Once-per-session markers, keyed on the Stop payload's session_id — a sibling
// of workflow-nudge's marker in the swarm home.
const SEEN = '.grade-nudge-seen.json';

function readJSON(p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; }
}

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

  const home = swarmHome(process.env);
  const seenPath = path.join(home, SEEN);
  // The store, read once — not per run, not per stop.
  const graded = gradedRunKeys(readRows(scoresPath(process.env)));
  const decision = decideGradeNudge({
    config,
    runs: ungradedRuns({ env: process.env, graded }),
    graded,
    sessionId,
    seen: readJSON(seenPath),
  });
  if (!decision.block) process.exit(0);

  try {
    const seen = readJSON(seenPath) || {};
    seen[sessionId] = Date.now();
    // Dead sessions' markers must not rot the file; a week outlives any session.
    for (const [k, v] of Object.entries(seen)) if (Date.now() - v > 7 * 86_400_000) delete seen[k];
    fs.mkdirSync(home, { recursive: true });
    fs.writeFileSync(seenPath, JSON.stringify(seen), 'utf8');
  } catch { /* marker failure must not break the nudge */ }

  process.stdout.write(JSON.stringify({ decision: 'block', reason: decision.reason }) + '\n');
  process.exit(0);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(() => process.exit(0));
}