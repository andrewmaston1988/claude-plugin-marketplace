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

// Both keep :cloud as the stated preference — an exhausted or stale meter is
// unavailable or unverified, never a reason to prefer Anthropic instead.
function modeExhausted(resetsAt) {
  return `[:cloud preferred but UNAVAILABLE — weekly allowance exhausted, resets ${resetsAt}; seat Claude tiers for this run]`;
}

function modeStale(snapshotAgeMs) {
  const hours = Math.floor(snapshotAgeMs / 3_600_000);
  return `[:cloud tier preferred — meter unverified, last read ${hours}h ago]`;
}

function readJSON(p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; }
}

export function standingBlock(mode) {
  return [
    '<EXTREMELY_IMPORTANT>',
    'Standing mode is ON (swarm.always): the swarm skill is PRE-AUTHORISED. RUN IT.',
    'Invoke Skill(swarm); read orchestrating-agents and executing-swarms — that reasoning',
    'is what makes the manifest defensible. Then models, author, validate, dispatch.',
    'Emit none of it: no arithmetic block, no gate statement, no caveat paragraph.',
    'Ask none of it: the offer gate, adversarial review, and every other settled call are',
    'ANSWERED — presenting one back for approval is the defect.',
    'Solo only on conversational turns, a single bounded question, or a trivial edit.',
    `Mode: ${mode}`,
    '</EXTREMELY_IMPORTANT>',
  ].join('\n');
}

// cwd under any allowed root -> alternative models are launchable here. Lazy import:
// manifest.mjs is the governance source of truth but heavy for a per-prompt hook.
// `headroom` is injected (the caller reads the cache file) so this stays pure —
// undefined behaves exactly as before headroom existed (an older caller, or a
// read that failed, never breaks standing mode).
export async function modeFor({ cwd, config, headroom }) {
  const roots = config?.provider?.allowedRoots ?? [];
  if (!roots.length || !cwd) return MODE_ANTHROPIC;
  const { isUnderRoot } = await import('../src/manifest.mjs');
  if (!roots.some((r) => isUnderRoot(cwd, r))) return MODE_ANTHROPIC;
  if (headroom?.state === 'exhausted') return modeExhausted(headroom.resetsAt);
  if (headroom?.state === 'stale') return modeStale(headroom.snapshotAgeMs);
  return MODE_CLOUD;
}

// The keyword as a standalone word — `ultraswarm.mjs` in a prompt about this file is not an opt-in.
const KEYWORD_RE = /(^|[^\w./-])ultraswarm(?![\w./-])/i;

// Pure: which event, what prompt, what config/cwd/headroom -> standing block or null.
export async function decide({ event, prompt = '', cwd, config, headroom }) {
  const armed = event === 'SessionStart' ? config?.swarm?.always === true
    : event === 'UserPromptSubmit' ? KEYWORD_RE.test(prompt)
      : false;
  return armed ? standingBlock(await modeFor({ cwd, config, headroom })) : null;
}

async function main() {
  let stdin = '';
  process.stdin.setEncoding('utf8');
  for await (const c of process.stdin) stdin += c;

  let payload = {};
  try { payload = JSON.parse(stdin); } catch { process.exit(0); }
  if (process.env.CORRELATION_ID) process.exit(0);

  const event = String(payload.hook_event_name || '');
  const config = readJSON(CONFIG);
  const { usageFromCache } = await import('../src/ollama-usage.mjs');
  const ctx = await decide({
    event,
    prompt: String(payload.prompt || ''),
    cwd: payload.cwd || process.cwd(),
    config,
    headroom: usageFromCache(config),
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
