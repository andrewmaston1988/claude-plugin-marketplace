#!/usr/bin/env node
// PreToolUse hook on the Workflow tool: block a Workflow call with a "consider swarm
// instead" reason. Two strengths:
//   standing mode (swarm.always) -> HARD BLOCK, every call, no budget, while a provider
//     resolves to allowedRoots. The operator has pre-authorised swarm; Workflow is the
//     wrong tool and a retry must not launder it.
//   otherwise                    -> speed bump, NUDGE_CAP firings per session, and only
//     when swarm's alternative-model path is armed (an enabled provider resolves to
//     allowedRoots). A retry passes straight through.
// Silent (exit 0) when: swarm isn't armed (no allowedRoots at all), the budget is spent,
// CORRELATION_ID is set (pipeline child), or swarm.workflowNudge === false. Never throws.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { pathToFileURL } from 'node:url';
import { allowedRootsFor, providerConfig } from '../src/providers.mjs';
import { NUDGE_CAP, underCap, recordFiring } from './nudge-count.mjs';

const SWARM_HOME = process.env.SWARM_HOME || path.join(os.homedir(), '.swarm');
const CONFIG = path.join(SWARM_HOME, 'config.json');
const SEEN = path.join(SWARM_HOME, '.workflow-nudge-seen.json');

function readJSON(p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; }
}

// Every id that could own roots: the canonical blocks the operator wrote, plus the two ids
// that are configurable without one (ollama via `provider`, codex via `codex` or a bare
// file). `claude` is excluded — this asks whether the ALTERNATIVE-model path is armed, not
// where swarm may run. A config setting only the top-level key has no `providers` object at
// all, so the two-id floor is what keeps those inherited roots visible.
function providerIds(config) {
  return [...new Set([...Object.keys(config?.providers || {}), 'ollama', 'codex'])]
    .filter((id) => id !== 'claude');
}

// Roots are resolved per provider so one naming none inherits the top-level list. The legacy
// `provider.allowedRoots` concat stays: this hook reads RAW config.json, and
// addLegacyProviderView never runs on a file off disk.
function allowedRoots(config) {
  const canonical = providerIds(config)
    .filter((id) => providerConfig(config, id)?.enabled !== false)
    .flatMap((id) => allowedRootsFor(config, id).roots || []);
  return [...new Set(canonical.concat(Array.isArray(config?.provider?.allowedRoots) ? config.provider.allowedRoots : []))];
}

// Pure decision: 'block' (standing mode, no budget), 'nudge' (budgeted), or false.
export function decideNudge({ config, seen, sessionId, correlationId }) {
  if (correlationId) return false;
  if (config?.swarm?.workflowNudge === false) return false;
  // Arming is checked before standing mode: with no dispatchable root swarm cannot take the
  // fan-out either, so a hard block would leave Workflow as the only tool and deny it.
  if (allowedRoots(config).length === 0) return false;
  if (config?.swarm?.always === true) return 'block';
  if (!sessionId) return false;
  return underCap(seen, sessionId) ? 'nudge' : false;
}

const CONSIDER = 'consider a swarm manifest instead of Workflow for this fan-out. Swarm runs the '
  + 'leaves on the configured providers, in the background, digest-compressed. Invoke the **swarm** '
  + 'skill. Provider runners and tool limits are explicit, so inspect the manifest when a leaf needs '
  + 'session-connected MCP tools (interactive auth), schema-validated returns wired into '
  + 'deterministic script logic, or this session\'s in-context state.';

export function nudgeReason(strength = 'nudge') {
  if (strength === 'block') {
    return 'Swarm gate: standing mode (swarm.always) is ON, so this is a hard block, not a speed '
      + `bump — calling Workflow again will not pass. Swarm is pre-authorised: ${CONSIDER} `
      + 'If Workflow is genuinely the only tool that can do this, disable the gate with '
      + '`swarm.workflowNudge: false` in ~/.swarm/config.json.';
  }
  return `Swarm nudge (fires at most ${NUDGE_CAP}x per session): alternative models are armed on `
    + `this machine — ${CONSIDER} If Workflow is the right tool anyway, simply call it again — this `
    + 'passes on the retry.';
}

async function main() {
  let stdin = '';
  process.stdin.setEncoding('utf8');
  for await (const c of process.stdin) stdin += c;
  let payload = {};
  try { payload = JSON.parse(stdin); } catch { process.exit(0); }

  const sessionId = String(payload.session_id || '');
  const strength = decideNudge({
    config: readJSON(CONFIG),
    seen: readJSON(SEEN),
    sessionId,
    correlationId: process.env.CORRELATION_ID,
  });
  if (!strength) process.exit(0);

  // A hard block has no budget, so it has nothing to remember.
  if (strength === 'nudge') recordFiring(SEEN, sessionId);

  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: nudgeReason(strength),
    },
  }) + '\n');
  process.exit(0);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(() => process.exit(0));
}
