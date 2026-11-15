// Resolve the token count at which Claude Code compacts this session.
// Pure: the caller supplies the model, the env and the settings chain.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import { contextWindowFor } from './context.mjs';

// Claude Code compacted ~33k below the configured window in every measured run.
export const COMPACT_BUFFER_TOKENS = 33_000;

const MIN_WINDOW = 100_000;
const MAX_WINDOW = 1_000_000;

function readSettingsFile(p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return {}; }
}

// Local, project, user — the order Claude Code resolves a key through.
export function readSettingsChain(cwd = process.cwd(), home = os.homedir()) {
  return [
    readSettingsFile(path.join(cwd, '.claude', 'settings.local.json')),
    readSettingsFile(path.join(cwd, '.claude', 'settings.json')),
    readSettingsFile(path.join(home, '.claude', 'settings.json')),
  ];
}

// Exact key, then the id with `[1m]`/date stripped, then the longest key the id
// contains — so claude-opus-5-5 wins over claude-opus-5 for a wrapped id.
export function modelSettingsEntry(modelSettings, model) {
  if (!modelSettings || typeof modelSettings !== 'object' || typeof model !== 'string') return undefined;
  const has = (k) => Object.prototype.hasOwnProperty.call(modelSettings, k);
  if (has(model)) return modelSettings[model];
  const stripped = model.replace(/\[1m\]$/, '').replace(/-\d{8}$/, '');
  if (has(stripped)) return modelSettings[stripped];
  let bestKey = '';
  for (const key of Object.keys(modelSettings)) {
    if (key.length > bestKey.length && model.includes(key)) bestKey = key;
  }
  return bestKey ? modelSettings[bestKey] : undefined;
}

// A window outside the documented 100k-1M range is no setting at all.
function parseWindow(v) {
  const n = Number(v);
  if (!Number.isFinite(n) || n < MIN_WINDOW || n > MAX_WINDOW) return null;
  return Math.floor(n);
}

function fromModelSettings(chain, model) {
  for (const s of chain) {
    const entry = modelSettingsEntry(s && s.modelSettings, model);
    const n = parseWindow(entry && entry.autoCompactWindow);
    if (n != null) return n;
  }
  return null;
}

function fromChain(chain, key) {
  for (const s of chain) {
    const n = parseWindow(s && s[key]);
    if (n != null) return n;
  }
  return null;
}

// { tokens, window, source }: `source` names the input that set the window.
export function compactTrigger({ model, env = process.env, settingsChain = [] } = {}) {
  const chain = Array.isArray(settingsChain) ? settingsChain : [];
  const isClaude = typeof model === 'string' && model.includes('claude');
  const modelWindow = contextWindowFor(model);

  let configured = parseWindow(env && env.CLAUDE_CODE_AUTO_COMPACT_WINDOW);
  let source = 'env';
  if (configured == null) { configured = fromModelSettings(chain, model); source = 'modelSettings'; }
  if (configured == null) { configured = fromChain(chain, 'autoCompactWindow'); source = 'settings'; }
  if (configured == null) source = 'model';

  // A third-party model's window is unknown, so only Claude families are capped.
  const window = configured == null
    ? modelWindow
    : (isClaude ? Math.min(configured, modelWindow) : configured);

  let tokens = window - COMPACT_BUFFER_TOKENS;

  // The percentage override only ever lowers the compaction point.
  const pct = Number(env && env.CLAUDE_AUTOCOMPACT_PCT_OVERRIDE);
  if (Number.isFinite(pct) && pct >= 1 && pct <= 100) {
    tokens = Math.min(tokens, Math.floor((tokens * pct) / 100));
  }

  return { tokens, window, source };
}
