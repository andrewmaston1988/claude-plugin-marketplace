#!/usr/bin/env node
// PreToolUse hook on the Workflow tool: once per session, when swarm's
// alternative-model path is armed (provider.allowedRoots non-empty), block the
// first Workflow call with a "consider swarm instead" reason. A retry passes
// straight through — this is a speed bump, not a wall. Silent (exit 0) when:
// swarm isn't armed, the nudge already fired this session, CORRELATION_ID is
// set (pipeline child), or swarm.workflowNudge === false. Never throws.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { pathToFileURL } from 'node:url';

const SWARM_HOME = process.env.SWARM_HOME || path.join(os.homedir(), '.swarm');
const CONFIG = path.join(SWARM_HOME, 'config.json');
const SEEN = path.join(SWARM_HOME, '.workflow-nudge-seen.json');

function readJSON(p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; }
}

// Pure decision: should this call be nudged?
export function decideNudge({ config, seen, sessionId, correlationId }) {
  if (correlationId) return false;
  if (!sessionId) return false;
  if (config?.swarm?.workflowNudge === false) return false;
  const roots = config?.provider?.allowedRoots;
  if (!Array.isArray(roots) || roots.length === 0) return false; // not armed — Workflow is the only game
  return !(seen && seen[sessionId]);
}

export function nudgeReason() {
  return 'Swarm nudge (fires once per session): alternative models are armed on this machine — '
    + 'consider a swarm manifest instead of Workflow for this fan-out. Swarm runs the leaves on '
    + 'capable :cloud models (GLM/MiniMax-class) with zero Anthropic usage, in the background, '
    + 'digest-compressed. Invoke the **swarm** skill and offer it via the question box. '
    + 'If Workflow is genuinely right here (leaves need harness tools, schemas, or session context), '
    + 'simply call Workflow again — this reminder will not repeat this session.';
}

async function main() {
  let stdin = '';
  process.stdin.setEncoding('utf8');
  for await (const c of process.stdin) stdin += c;
  let payload = {};
  try { payload = JSON.parse(stdin); } catch { process.exit(0); }

  const nudge = decideNudge({
    config: readJSON(CONFIG),
    seen: readJSON(SEEN),
    sessionId: String(payload.session_id || ''),
    correlationId: process.env.CORRELATION_ID,
  });
  if (!nudge) process.exit(0);

  try {
    const seen = readJSON(SEEN) || {};
    seen[String(payload.session_id)] = Date.now();
    // Keep the marker file from growing forever — entries older than a day are dead sessions.
    for (const [k, v] of Object.entries(seen)) if (Date.now() - v > 86_400_000) delete seen[k];
    fs.mkdirSync(SWARM_HOME, { recursive: true });
    fs.writeFileSync(SEEN, JSON.stringify(seen), 'utf8');
  } catch { /* marker failure must not break the nudge */ }

  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: nudgeReason(),
    },
  }) + '\n');
  process.exit(0);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(() => process.exit(0));
}
