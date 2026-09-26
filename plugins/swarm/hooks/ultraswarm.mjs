#!/usr/bin/env node
// Standing-mode announcement, one block, two events: SessionStart (startup|clear|compact)
// when ~/.swarm/config.json sets swarm.always, UserPromptSubmit on the 'ultraswarm' keyword.
// Silent otherwise. Never throws — always exits 0; skips if CORRELATION_ID set.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { pathToFileURL } from 'node:url';
import { notableLines } from '../src/usage.mjs';
import { allowedRootsFor, providerConfig } from '../src/providers.mjs';

const CONFIG = path.join(os.homedir(), '.swarm', 'config.json');

// Kept as a named export for hook consumers; the label is now provider-neutral.
export const MODE_CLOUD = '[configured provider models preferred]';
export const MODE_ANTHROPIC = '[Anthropic orchestration only]';

// Headroom lines print OUTSIDE the standing block: the mode bracket says which
// tier is preferred and nothing else. Meter state is availability, not
// preference — an exhausted or stale meter never makes Anthropic the preference.
// Wording and provider coverage belong to src/usage.mjs, so the hook and `quota`
// cannot drift.

function readJSON(p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; }
}

// The block is OPERATOR-LOCKED (2026-09-26) in scout's shape — identity line, a nested
// non-negotiable trigger, The Rule, and a Red Flags table of rationalisations. Do not
// reflow, reword or "improve" a line of it: tests/ultraswarm.test.mjs transcribes the
// locked text verbatim, so any edit outside an operator decision fails there first.
const IDENTITY = 'You have swarm. The operator has decided in advance: swarm is PRE-AUTHORISED.';

function blockLines(mode, identity) {
  return [
    '<EXTREMELY_IMPORTANT>',
    identity,
    'It spreads cost across providers, optimises spend, offloads and compresses carried',
    'context, and applies committee judgement. The trade-off is settled — not yours to weigh.',
    '',
    '<EXTREMELY-IMPORTANT>',
    'If there is even a 1% chance work can be delegated, fanned out, or judged by',
    'another model, you ABSOLUTELY MUST swarm it.',
    'This is not negotiable. You cannot rationalise your way out of it.',
    '</EXTREMELY-IMPORTANT>',
    '',
    '## The Rule',
    '**Before any delegable work**: invoke Skill(swarm:swarm), read orchestrating-agents',
    'and executing-swarms, then models -> author -> validate -> dispatch. Emit none of the',
    'reasoning. Ask none of the settled calls: presenting one back for approval is the defect.',
    'Solo ONLY for a conversational reply, a single one-read question, or a trivial edit.',
    '',
    '## Red Flags',
    '| Thought | Reality |',
    '|---|---|',
    '| "Inline is quicker" | The operator decided in advance. Period. |',
    '| "It\'s too small to swarm" | Size is not the test. The decision is already made. |',
    '| "A leaf will do it worse" | You verify every leaf; committee judgement beats one pass. |',
    '| "I\'ll check with the operator first" | They answered in advance. Asking back is the defect. |',
    '| "I know the command, I can skip the skill" | The command arrives without the rules that govern it. |',
    '| "An Agent/Workflow will do" | Swarm is the fan-out tier; Agent only for one run that must be on Anthropic. |',
    '| "I\'ll peek at the leaf\'s log" | One status check, then hands-off until the notification. |',
    '',
    `Mode: ${mode}`,
    '</EXTREMELY_IMPORTANT>',
  ];
}

export function standingBlock(mode) {
  return blockLines(mode, IDENTITY).join('\n');
}

// A fresh install has no config file at all, so nothing here can be pre-authorised yet: the
// same block carries the setup route where the standing claim would sit, and every other
// line stays — the operator, 2026-09-26: "It shouldnt swap anything; it should show the
// message when swarm is not yet configured."
const SETUP_IDENTITY = 'You have the swarm plugin but it is not configured, the operator has installed it and expects it to work. The first thing that you must do is run /swarm:swarm setup';

function setupBlock(mode) {
  return blockLines(mode, SETUP_IDENTITY).join('\n');
}

// Every id that could own roots: the canonical blocks the operator wrote, plus the two ids
// that are configurable without one (ollama via `provider`, codex via `codex` or a bare
// file). `claude` is excluded — see modeFor. A config setting ONLY the top-level key has no
// `providers` object at all, so the two-id floor is what keeps inherited roots visible;
// enumerating `providers` alone would call that config unarmed while the gate calls it armed.
function providerIds(config) {
  return [...new Set([...Object.keys(config?.providers || {}), "ollama", "codex"])]
    .filter((id) => id !== 'claude');
}

// Roots are resolved per provider rather than read off the block, so a provider that names
// none inherits the top-level list. The legacy `provider.allowedRoots` concat stays: this
// hook reads RAW config.json, and addLegacyProviderView never runs on a file off disk.
// Empty means the install never ran setup — nothing is dispatchable, whatever the mode says.
function configuredRoots(config) {
  return [...new Set(providerIds(config)
    .filter((id) => providerConfig(config, id)?.enabled !== false)
    .flatMap((id) => allowedRootsFor(config, id).roots || [])
    .concat(Array.isArray(config?.provider?.allowedRoots) ? config.provider.allowedRoots : []))];
}

// cwd under any allowed root -> alternative models are launchable here. Lazy import:
// manifest.mjs is the governance source of truth but heavy for a per-prompt hook.
//
// Claude is EXCLUDED here and included by the run-level gate. The two are not the same
// question: this one is "is the alternative-model path armed?", not "where may swarm run".
export async function modeFor({ cwd, config }) {
  const roots = configuredRoots(config);
  if (!roots.length || !cwd) return MODE_ANTHROPIC;
  const { isUnderRoot } = await import('../src/manifest.mjs');
  return roots.some((r) => isUnderRoot(cwd, r)) ? MODE_CLOUD : MODE_ANTHROPIC;
}

// The keyword as a standalone word — `ultraswarm.mjs` in a prompt about this file is not an opt-in.
const KEYWORD_RE = /(^|[^\w./-])ultraswarm(?![\w./-])/i;

// Pure: which event, what prompt, what config/cwd/usage -> standing block or null.
// `usage` is readCachedUsage()'s array; the caller reads it, so this stays pure
// and an absent argument behaves exactly as before usage existed.
export async function decide({ event, prompt = '', cwd, config, usage = [] }) {
  // SessionStart alone may fire without swarm.always: an install with no roots dispatches
  // nothing, so the session has to learn the way out before it tries. The keyword event is
  // unchanged — a user asking for the swarm on a prompt still gets the standing block.
  const unconfigured = event === 'SessionStart' && !configuredRoots(config).length;
  const armed = event === 'SessionStart' ? config?.swarm?.always === true || unconfigured
    : event === 'UserPromptSubmit' ? KEYWORD_RE.test(prompt)
      : false;
  if (!armed) return null;
  const mode = await modeFor({ cwd, config });
  const block = unconfigured ? setupBlock(mode) : standingBlock(mode);
  const lines = notableLines(usage);
  return lines.length ? `${block}\n${lines.join('\n')}` : block;
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
  const { readCachedUsage } = await import('../src/usage.mjs');
  const { defaultProviderRegistry } = await import('../src/default-providers.mjs');
  const ctx = await decide({
    event,
    prompt: String(payload.prompt || ''),
    cwd: payload.cwd || process.cwd(),
    config,
    usage: await readCachedUsage(config, { providerRegistry: defaultProviderRegistry() }),
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
