#!/usr/bin/env node
// Stop hook: at every stop, name the finished runs in the session's repo (any session's)
// that still hold kept worktrees, with the prune command for each. Silent (exit 0) on a
// continuation stop, outside a repo, or on unparseable stdin — a hook must never break
// the stop.
import { pathToFileURL } from 'node:url';
import { swarmHome } from '../src/config.mjs';
import { realRepoToplevel } from '../src/manifest-leaf-guard.mjs';
import { projectRunsHoldingWorktrees, decidePruneNudge } from '../src/prune-nudge.mjs';

async function main() {
  let stdin = '';
  process.stdin.setEncoding('utf8');
  for await (const c of process.stdin) stdin += c;
  let payload = {};
  try { payload = JSON.parse(stdin); } catch { process.exit(0); }
  if (payload.stop_hook_active) process.exit(0);

  const toplevel = payload.cwd ? realRepoToplevel(payload.cwd) : null;
  if (!toplevel) process.exit(0);
  const decision = decidePruneNudge({ runs: projectRunsHoldingWorktrees({ home: swarmHome(process.env), toplevel }) });
  if (!decision.block) process.exit(0);

  process.stdout.write(JSON.stringify({ decision: 'block', reason: decision.reason }) + '\n');
  process.exit(0);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(() => process.exit(0));
}
