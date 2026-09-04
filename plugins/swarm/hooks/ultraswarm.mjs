#!/usr/bin/env node
// Standing-mode announcement, one block, two events: SessionStart (startup|clear|compact)
// when ~/.swarm/config.json sets swarm.always, UserPromptSubmit on the 'ultraswarm' keyword.
// Silent otherwise. Never throws — always exits 0; skips if CORRELATION_ID set.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { pathToFileURL } from 'node:url';

const CONFIG = path.join(os.homedir(), '.swarm', 'config.json');

export const MODE_CLOUD = '[:cloud tier preferred]';
export const MODE_ANTHROPIC = '[Anthropic orchestration only]';

function readJSON(p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; }
}

export function standingBlock(mode) {
  return [
    '<EXTREMELY_IMPORTANT>',
    'Swarm standing mode is ON (swarm.always): the swarm skill is PRE-AUTHORISED for',
    'model orchestration and explicitly expected whenever a multi-phase task begins.',
    "The offer gate's consent is already given — invoke Skill(swarm), run its ceremony",
    '(orchestrating-agents, executing-swarms, models, validate), state the gate, dispatch.',
    'Token cost is not the reason to stay inline; leaves spend other budgets and cheaper tiers.',
    'Solo only on conversational turns, a single bounded question, or a trivial edit.',
    `Mode: ${mode}`,
    '</EXTREMELY_IMPORTANT>',
  ].join('\n');
}

// cwd under any allowed root -> alternative models are launchable here. Lazy import:
// manifest.mjs is the governance source of truth but heavy for a per-prompt hook.
export async function modeFor({ cwd, config }) {
  const roots = config?.provider?.allowedRoots ?? [];
  if (!roots.length || !cwd) return MODE_ANTHROPIC;
  const { isUnderRoot } = await import('../src/manifest.mjs');
  return roots.some((r) => isUnderRoot(cwd, r)) ? MODE_CLOUD : MODE_ANTHROPIC;
}

// The keyword as a standalone word — `ultraswarm.mjs` in a prompt about this file is not an opt-in.
const KEYWORD_RE = /(^|[^\w./-])ultraswarm(?![\w./-])/i;

// Pure: which event, what prompt, what config/cwd -> standing block or null.
export async function decide({ event, prompt = '', cwd, config }) {
  const armed = event === 'SessionStart' ? config?.swarm?.always === true
    : event === 'UserPromptSubmit' ? KEYWORD_RE.test(prompt)
      : false;
  return armed ? standingBlock(await modeFor({ cwd, config })) : null;
}

async function main() {
  let stdin = '';
  process.stdin.setEncoding('utf8');
  for await (const c of process.stdin) stdin += c;

  let payload = {};
  try { payload = JSON.parse(stdin); } catch { process.exit(0); }
  if (process.env.CORRELATION_ID) process.exit(0);

  const event = String(payload.hook_event_name || '');
  const ctx = await decide({
    event,
    prompt: String(payload.prompt || ''),
    cwd: payload.cwd || process.cwd(),
    config: readJSON(CONFIG),
  });
  if (!ctx) process.exit(0);

  process.stdout.write(JSON.stringify({
    hookSpecificOutput: { hookEventName: event, additionalContext: ctx },
  }) + '\n');
  process.exit(0);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch(() => process.exit(0));
}
