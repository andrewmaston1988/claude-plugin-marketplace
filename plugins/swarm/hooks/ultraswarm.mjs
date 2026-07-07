#!/usr/bin/env node
// UserPromptSubmit hook: opt-in ultraswarm standing mode. Emits standing instructions
// when the prompt contains 'ultraswarm' or ~/.swarm/config.json sets swarm.always: true.
// Silent otherwise. Never throws — always exits 0; skips if CORRELATION_ID set.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { pathToFileURL } from 'node:url';

const CONFIG = path.join(os.homedir(), '.swarm', 'config.json');
const MODELS_CACHE = path.join(os.homedir(), '.swarm', 'models-cache.json');
const MAX_MODELS = 40;

function readJSON(p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; }
}

// Cache shape is owned by `swarm.mjs models`; accept the plausible shapes defensively.
export function formatModelList(cache) {
  try {
    const list = Array.isArray(cache) ? cache
      : Array.isArray(cache?.models) ? cache.models
        : Array.isArray(cache?.recommendations) ? cache.recommendations
          : null;
    if (!list || list.length === 0) return '';
    return list.slice(0, MAX_MODELS).map((m) => {
      if (typeof m === 'string') return `- ${m}`;
      const name = m?.model || m?.name;
      if (!name) return null;
      return m.description ? `- ${name} — ${m.description}` : `- ${name}`;
    }).filter(Boolean).join('\n');
  } catch { return ''; }
}

export function buildStandingInstructions(modelList) {
  let ctx = 'Ultraswarm standing mode is active. For every substantive task in this prompt that '
    + 'decomposes into independent bounded leaves, draft a swarm manifest and propose it via '
    + 'AskUserQuestion — options: Yes (Recommended) / No, inline / Discuss, with the draft manifest '
    + 'as the option preview — before doing the work inline. Invoke the **swarm** skill for the '
    + 'manifest schema, plan patterns, and the data-governance rule. Do not swarm a single bounded '
    + 'question — answer it inline.';
  if (modelList) {
    ctx += '\n\nModels available from the last discovery (refresh with `swarm.mjs models`):\n' + modelList;
  }
  return ctx;
}

async function main() {
  let stdin = '';
  process.stdin.setEncoding('utf8');
  for await (const c of process.stdin) stdin += c;

  let payload = {};
  try { payload = JSON.parse(stdin); } catch { process.exit(0); }
  if (process.env.CORRELATION_ID) process.exit(0);

  const prompt = String(payload.prompt || '');
  const config = readJSON(CONFIG);
  const active = prompt.toLowerCase().includes('ultraswarm') || config?.swarm?.always === true;
  if (!active) process.exit(0);

  const ctx = buildStandingInstructions(formatModelList(readJSON(MODELS_CACHE)));
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: ctx },
  }) + '\n');
  process.exit(0);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(() => process.exit(0));
}
