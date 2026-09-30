#!/usr/bin/env node
// Stop hook: at every stop, name the finished runs in the session's repo (any session's)
// that still hold kept worktrees. Silent (exit 0) in a leaf, on a continuation stop,
// outside a repo, or on unparseable stdin — a hook must never break the stop.
import { pathToFileURL } from 'node:url';
import { swarmHome } from '../src/config.mjs';
import { realRepoToplevel } from '../src/manifest-leaf-guard.mjs';
import { projectRunsHoldingWorktrees, decidePruneNudge, inLeafOrAutonomous } from '../src/prune-nudge.mjs';

async function main() {
  let stdin = '';
  process.stdin.setEncoding('utf8');
  for await (const c of process.stdin) stdin += c;
  let payload = {};
  try { payload = JSON.parse(stdin); } catch { process.exit(0); }
  // Before the repo scan: a leaf stops often and is never asked.
  if (payload.stop_hook_active || inLeafOrAutonomous(process.env)) process.exit(0);

  const toplevel = payload.cwd ? realRepoToplevel(payload.cwd) : null;
  if (!toplevel) process.exit(0);
  const decision = decidePruneNudge({ runs: projectRunsHoldingWorktrees({ home: swarmHome(process.env), toplevel }), env: process.env });
  if (!decision.block) process.exit(0);

  process.stdout.write(JSON.stringify({ decision: 'block', reason: decision.reason }) + '\n');
  process.exit(0);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(() => process.exit(0));
}
