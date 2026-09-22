#!/usr/bin/env node
// PreToolUse hook on the Agent tool: stop a call that leaves `model` unpinned, so the
// leaf's model is a decision someone made rather than whatever the session happened to
// be running.
//
// Why this exists and why it is NOT shaped like the Workflow nudge's arming check:
//
// An `Agent` call with no `model` inherits the session model. An Explore sweeping
// filenames, or a general-purpose agent doing a bounded lookup, then runs at opus rate
// for work fable or haiku does identically — and nothing in the tool's surface asks the
// question. That burn is live with zero alternative providers configured, so this does
// NOT gate on allowedRoots: fable and haiku are Claude models and the choice exists on
// any machine.
//
// A pinned `model` always passes, standing mode included — a deliberate single leaf on
// Anthropic is a legitimate shape, and the budget is spent only on real defects.
//
// Two strengths:
//   standing mode (swarm.always) -> HARD BLOCK, every unpinned call, no budget.
//   otherwise                    -> speed bump, NUDGE_CAP firings per session.
//
// Silent (exit 0) when: `model` is pinned, CORRELATION_ID is set (pipeline child), the
// budget is spent, or swarm.agentNudge === false. Never throws.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { pathToFileURL } from 'node:url';
import { NUDGE_CAP, underCap, recordFiring } from './nudge-count.mjs';

const SWARM_HOME = process.env.SWARM_HOME || path.join(os.homedir(), '.swarm');
const CONFIG = path.join(SWARM_HOME, 'config.json');
const SEEN = path.join(SWARM_HOME, '.agent-nudge-seen.json');

function readJSON(p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; }
}

// Pure decision: 'block' (standing mode, no budget), 'nudge' (budgeted), or false.
export function decideNudge({ config, seen, sessionId, toolInput, correlationId }) {
  if (correlationId) return false;
  if (config?.swarm?.agentNudge === false) return false;
  const model = toolInput?.model;
  if (typeof model === 'string' && model.trim() !== '') return false;
  if (config?.swarm?.always === true) return 'block';
  if (!sessionId) return false;
  return underCap(seen, sessionId) ? 'nudge' : false;
}

const MODELS = '`model: "fable"` | `"haiku"` | `"sonnet"` | `"opus"`';

export function nudgeReason(toolInput, strength = 'nudge') {
  const type = toolInput?.subagent_type || 'general-purpose';
  const head = `Swarm gate: this Agent call has no \`model\`, so the leaf inherits THIS session's model. `
    + `Pick one deliberately — a bounded ${type} leaf sweeping filenames or looking one thing up runs `
    + `the same on fable or haiku as on opus, at a fraction of the cost.\n\n`
    + `Fix: add \`model\` to the call — ${MODELS}.\n\n`;

  if (strength === 'block') {
    return head
      + `Standing mode (swarm.always) is ON, so this is a hard block, not a speed bump — an unpinned `
      + `Agent call will not pass. Re-send with \`model\` pinned if one Anthropic leaf is genuinely the `
      + `right shape; otherwise this is a swarm manifest — invoke the **swarm** skill.\n\n`
      + `(Disable this gate entirely with \`swarm.agentNudge: false\` in ~/.swarm/config.json.)`;
  }

  return head
    + `While you are there, check the shape: is one Anthropic leaf actually right? 3+ independent `
    + `bounded leaves, alternative models, or work that should run outside this session is a swarm `
    + `manifest — invoke the **swarm** skill. \`Agent\` is for a single execution that must run on `
    + `Anthropic.\n\n`
    + `Re-send with \`model\` pinned and this passes. Fires at most ${NUDGE_CAP}x per session.`;
}

async function main() {
  let stdin = '';
  process.stdin.setEncoding('utf8');
  for await (const c of process.stdin) stdin += c;
  let payload = {};
  try { payload = JSON.parse(stdin); } catch { process.exit(0); }

  const sessionId = String(payload.session_id || '');
  const toolInput = payload.tool_input || {};
  const strength = decideNudge({
    config: readJSON(CONFIG),
    seen: readJSON(SEEN),
    sessionId,
    toolInput,
    correlationId: process.env.CORRELATION_ID,
  });
  if (!strength) process.exit(0);

  // A hard block has no budget, so it has nothing to remember.
  if (strength === 'nudge') recordFiring(SEEN, sessionId);

  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: nudgeReason(toolInput, strength),
    },
  }) + '\n');
  process.exit(0);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch(() => process.exit(0));
}
