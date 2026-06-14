import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

export const STATE_DB = path.join(os.homedir(), '.claude', '.amag-checkpoint-state.json');
export const MARKER   = path.join(os.homedir(), '.claude', '.compact_just_ran');
export const KEEPALIVE_LOG = path.join(os.homedir(), '.claude', '.amag-checkpoint-keepalive.jsonl');

export function encodeProject(p) { return p.replace(/[\\/:]/g, '-'); }

export function resolveStatePath(cwd) {
  if (process.env.CLAUDE_STATE_PATH) return process.env.CLAUDE_STATE_PATH;
  return path.join(os.homedir(), '.claude', 'projects', encodeProject(cwd), 'STATE.md');
}

export function readJSON(p, fallback) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return fallback; }
}

export function writeJSON(p, obj) {
  try {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    const tmp = p + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(obj, null, 2), 'utf8');
    fs.renameSync(tmp, p);
  } catch { /* non-fatal */ }
}

// Normalise a session entry; supports the legacy `<sid>: <number>` format.
export function getSessionState(state, sid) {
  const cur = state[sid];
  if (cur && typeof cur === 'object') return cur;
  if (typeof cur === 'number') return { lastSize: cur, userTs: 0, lastActivityTs: 0, lastTickTs: 0, lastInjectedDelay: 0, lastFiredPct: null };
  return { lastSize: 0, userTs: 0, lastActivityTs: 0, lastTickTs: 0, lastInjectedDelay: 0, lastFiredPct: null };
}

export function appendJSONL(p, obj) {
  try {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.appendFileSync(p, JSON.stringify(obj) + '\n', 'utf8');
  } catch { /* non-fatal */ }
}
