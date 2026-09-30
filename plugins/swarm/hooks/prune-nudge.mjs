#!/usr/bin/env node
// Stop hook: one line naming how many worktrees THIS session's finished runs still
// hold, each run named once. The per-run list is `swarm status --mine`'s output.
// Silent (exit 0) in a leaf, on a continuation stop, outside a repo, with no session
// id in the payload, or on unparseable stdin — a hook must never break the stop.
import { pathToFileURL } from 'node:url';
import { swarmHome, loadConfig } from '../src/config.mjs';
import { realRepoToplevel } from '../src/manifest-leaf-guard.mjs';
import { projectRunsHoldingWorktrees, decidePruneNudge, writePruneMarker, inLeafOrAutonomous } from '../src/prune-nudge.mjs';

async function main() {
  let stdin = '';
  process.stdin.setEncoding('utf8');
  for await (const c of process.stdin) stdin += c;
  let payload = {};
  try { payload = JSON.parse(stdin); } catch { process.exit(0); }
  // Before the repo scan: a leaf stops often and is never asked.
  if (payload.stop_hook_active || inLeafOrAutonomous(process.env)) process.exit(0);
  // The session the run list is scoped to, straight from the host that is stopping.
  const sessionId = payload.session_id;
  if (!sessionId) process.exit(0);

  const toplevel = payload.cwd ? realRepoToplevel(payload.cwd) : null;
  if (!toplevel) process.exit(0);
  let config;
  try { config = loadConfig(undefined, process.env); } catch { process.exit(0); }
  if (config?.swarm?.pruneNudge === false) process.exit(0);
  const runs = projectRunsHoldingWorktrees({ home: swarmHome(process.env), toplevel, sessionId });
  const decision = decidePruneNudge({ ...runs, env: process.env, config });
  if (!decision.block) process.exit(0);

  process.stdout.write(JSON.stringify({ decision: 'block', reason: decision.reason }) + '\n');
  // The marker is what stops this run being named again for this launcher. Written
  // after the line, so a marker that cannot be written costs one repeat, never the nudge.
  for (const r of runs.mine) {
    try { writePruneMarker(r.dir, sessionId); } catch { /* the next stop repeats the line */ }
  }
  process.exit(0);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(() => process.exit(0));
}
