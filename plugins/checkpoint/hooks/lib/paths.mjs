import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

export const STATE_DB = path.join(os.homedir(), '.claude', '.checkpoint-state.json');
export const MARKER   = path.join(os.homedir(), '.claude', '.compact_just_ran');
export const KEEPALIVE_LOG = path.join(os.homedir(), '.claude', '.checkpoint-keepalive.jsonl');

export function encodeProject(p) { return p.replace(/[\\/:]/g, '-'); }

// Filename: STATE_[<slug>_]<sanitizedSid>_<YYYYMMDDTHHMMSSZ>.md
// UTC ISO compact timestamp sorts lexicographically (descending = newest first).
// Group 1 spans `_`, so it captures `slug_sid` on slugged names.
const STATE_FILE_RE = /^STATE_([A-Za-z0-9_-]+)_(\d{8}T\d{6}Z)\.md$/;

export function sanitizeSid(sid) {
  if (!sid) return '';
  return String(sid).replace(/[^A-Za-z0-9_-]/g, '');
}

// Slug is kebab-only (never `_`), so the trailing `_<sid>` stays unambiguous.
export function sanitizeSlug(slug) {
  if (!slug) return '';
  return String(slug).replace(/[^A-Za-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

export function nowStamp(d = new Date()) {
  // YYYYMMDDTHHMMSSZ (UTC)
  const pad = (n) => String(n).padStart(2, '0');
  return (
    d.getUTCFullYear().toString() +
    pad(d.getUTCMonth() + 1) +
    pad(d.getUTCDate()) + 'T' +
    pad(d.getUTCHours()) +
    pad(d.getUTCMinutes()) +
    pad(d.getUTCSeconds()) + 'Z'
  );
}

export function projectDir(cwd) {
  return path.join(os.homedir(), '.claude', 'projects', encodeProject(cwd));
}

// Compose the canonical per-session filename; empty sid yields ''.
export function sessionStateFilename(sid, stamp, slug = '') {
  const safe = sanitizeSid(sid);
  if (!safe) return '';
  const s = sanitizeSlug(slug);
  return s ? `STATE_${s}_${safe}_${stamp}.md` : `STATE_${safe}_${stamp}.md`;
}

// Writer path: per-session file. If one already exists for this sid in the
// project dir, maintain it (preserve original timestamp); otherwise mint a new
// one with the current UTC stamp. Returns absolute path or '' if no sid.
// `CLAUDE_STATE_PATH` overrides everything (escape hatch).
export function resolveOwnStatePath(cwd, sid, opts = {}) {
  if (process.env.CLAUDE_STATE_PATH) return process.env.CLAUDE_STATE_PATH;
  const safe = sanitizeSid(sid);
  if (!safe) return '';
  const dir = projectDir(cwd);
  let existing = '';
  try {
    for (const name of fs.readdirSync(dir)) {
      const m = name.match(STATE_FILE_RE);
      if (m && (m[1] === safe || m[1].endsWith('_' + safe))) { existing = path.join(dir, name); break; }
    }
  } catch { /* dir missing yet — fine */ }
  if (existing) return existing;
  const stamp = (opts.now && nowStamp(opts.now)) || nowStamp();
  return path.join(dir, sessionStateFilename(safe, stamp, opts.slug || ''));
}

// Resume path: most-recent STATE_* by the UTC timestamp in the filename.
// Filenames embed `YYYYMMDDTHHMMSSZ` after the sid, but the sid's character
// range can swamp the timestamp lexically (sid 'C' > sid 'B' even if
// B's date is later). Extract the stamp and compare on that.
// `CLAUDE_STATE_PATH` overrides. Returns '' if no per-session file exists.
export function resolveLatestStatePath(cwd) {
  if (process.env.CLAUDE_STATE_PATH) {
    return fs.existsSync(process.env.CLAUDE_STATE_PATH) ? process.env.CLAUDE_STATE_PATH : '';
  }
  let entries = [];
  try { entries = fs.readdirSync(projectDir(cwd)); } catch { return ''; }
  let best = null, bestStamp = '';
  for (const name of entries) {
    const m = name.match(STATE_FILE_RE);
    if (!m) continue;
    const stamp = m[2];
    if (stamp > bestStamp) { bestStamp = stamp; best = name; }
  }
  return best ? path.join(projectDir(cwd), best) : '';
}

// Backwards-compat shim: prefer per-session path if one exists, else fall back
// to the legacy `STATE.md` only if the per-session dir is empty. Callers that
// wrote before this migration still hit a stable path; new callers write into
// the per-session file. New code should call resolveOwnStatePath or
// resolveLatestStatePath directly.
export function resolveStatePath(cwd, sid) {
  if (process.env.CLAUDE_STATE_PATH) return process.env.CLAUDE_STATE_PATH;
  const own = sid ? resolveOwnStatePath(cwd, sid) : '';
  if (own) return own;
  return path.join(projectDir(cwd), 'STATE.md');
}

// True if `body` has user-meaningful content (not empty, not just whitespace).
// Used by the snapshot hook to refuse self-clobber of a non-empty STATE.
// Rename a STATE file to embed the *current* UTC stamp. The sessionId portion
// of the filename is preserved; only the trailing `YYYYMMDDTHHMMSSZ` advances.
// If the target name already exists in the same directory (e.g. another
// checkpoint landed in the same second), bump `now` by one second until the
// target is free — never clobber a parallel write. Returns the new absolute
// path. Throws if `oldPath` is not a STATE file or does not exist.
export function renameStateToNow(oldPath, now = new Date()) {
  if (!oldPath) throw new Error('renameStateToNow: oldPath required');
  if (!fs.existsSync(oldPath)) throw new Error(`renameStateToNow: source not found: ${oldPath}`);
  const dir = path.dirname(oldPath);
  const base = path.basename(oldPath);
  const m = base.match(STATE_FILE_RE);
  if (!m) throw new Error(`renameStateToNow: not a STATE file: ${base}`);
  const sid = m[1];
  let stamp = nowStamp(now);
  // Bump by 1s on collision; cap at 60s to avoid runaway loops in degenerate cases.
  for (let i = 0; i < 60; i++) {
    const target = path.join(dir, sessionStateFilename(sid, stamp));
    if (!fs.existsSync(target)) {
      fs.renameSync(oldPath, target);
      return target;
    }
    const d = new Date(now.getTime() + (i + 1) * 1000);
    stamp = nowStamp(d);
  }
  throw new Error(`renameStateToNow: could not find free stamp in 60s window for ${oldPath}`);
}

export function isMeaningfulState(body) {
  if (typeof body !== 'string') return false;
  const stripped = body.replace(/[\s ]+/g, '');
  return stripped.length > 0;
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
  if (typeof cur === 'number') return { lastSize: cur, userTs: 0, lastActivityTs: 0, lastTickTs: 0, lastInjectedDelay: 0, lastFiredPct: null, lastInjectTs: 0, injectPending: false };
  return { lastSize: 0, userTs: 0, lastActivityTs: 0, lastTickTs: 0, lastInjectedDelay: 0, lastFiredPct: null, lastInjectTs: 0, injectPending: false };
}

export function appendJSONL(p, obj) {
  try {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.appendFileSync(p, JSON.stringify(obj) + '\n', 'utf8');
  } catch { /* non-fatal */ }
}
