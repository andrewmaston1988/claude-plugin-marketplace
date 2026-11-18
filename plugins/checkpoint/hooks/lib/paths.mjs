import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

export const STATE_DB = path.join(os.homedir(), '.claude', '.checkpoint-state.json');
export const KEEPALIVE_LOG = path.join(os.homedir(), '.claude', '.checkpoint-keepalive.jsonl');
// Per-session nudge state and band claims. Its own dir, never STATE_DB: the
// PostToolUse hook must not race the keepalive's whole-map read-modify-write.
export const NUDGE_DIR = path.join(os.homedir(), '.claude', '.checkpoint-nudge');

export function encodeProject(p) { return p.replace(/[\\/:]/g, '-'); }

// Filename: STATE_[<slug>_]<sanitizedSid>_<YYYYMMDDTHHMMSSZ>.md
// UTC ISO compact timestamp sorts lexicographically (descending = newest first).
// Group 1 spans `_`, so it captures `slug_sid` on slugged names.
export const STATE_FILE_RE = /^STATE_([A-Za-z0-9_-]+)_(\d{8}T\d{6}Z)\.md$/;

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

// The only `saved:` form the lint accepts: minute resolution, UTC, 20 characters.
export const SAVED_RE = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2} UTC$/;
export const SAVED_EXAMPLE = '2026-11-18 01:56 UTC';

export function savedStamp(d = new Date()) {
  const pad = (n) => String(n).padStart(2, '0');
  return (
    d.getUTCFullYear().toString() + '-' +
    pad(d.getUTCMonth() + 1) + '-' +
    pad(d.getUTCDate()) + ' ' +
    pad(d.getUTCHours()) + ':' +
    pad(d.getUTCMinutes()) + ' UTC'
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
// project dir, maintain the NEWEST-stamped one (a fresh slugged file can sit
// beside an older skeleton); otherwise mint a new one with the current UTC
// stamp. Returns absolute path or '' if no sid.
// `CLAUDE_STATE_PATH` overrides everything (escape hatch).
export function resolveOwnStatePath(cwd, sid, opts = {}) {
  if (process.env.CLAUDE_STATE_PATH) return process.env.CLAUDE_STATE_PATH;
  const safe = sanitizeSid(sid);
  if (!safe) return '';
  const dir = projectDir(cwd);
  let existing = '';
  let existingStamp = '';
  try {
    for (const name of fs.readdirSync(dir)) {
      const m = name.match(STATE_FILE_RE);
      if (!m || !(m[1] === safe || m[1].endsWith('_' + safe))) continue;
      if (!existing || m[2] > existingStamp) { existing = path.join(dir, name); existingStamp = m[2]; }
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

// Parse a STATE filename into its parts. Slug is kebab-only (never `_`), so on a
// slugged name the text before the first `_` is unambiguously the slug. An
// UNSLUGGED sid containing `_` would mis-yield a slug here — sanitizeSid permits
// underscores even though session ids in practice do not have them. That is
// tolerable because the result is display-only: never resolve a path from it.
export function parseStateName(basename) {
  const m = String(basename).match(STATE_FILE_RE);
  if (!m) return null;
  const blob = m[1];
  const cut = blob.indexOf('_');
  return {
    slug: cut > 0 ? blob.slice(0, cut) : '',
    sid: cut > 0 ? blob.slice(cut + 1) : blob,
    stamp: m[2],
    stampMs: stampToMs(m[2]),
  };
}

export function stampToMs(stamp) {
  const m = String(stamp).match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/);
  if (!m) return 0;
  const [, y, mo, d, h, mi, sec] = m.map(Number);
  return Date.UTC(y, mo - 1, d, h, mi, sec);
}

// First `session:` frontmatter line of a STATE file — already a one-line
// summary, so it feeds option descriptions directly. '' when absent/unreadable.
export function readStateSummary(statePath) {
  let body = '';
  try { body = fs.readFileSync(statePath, 'utf8'); } catch { return ''; }
  const m = body.match(/^session:\s*(.+)$/m);
  return m ? m[1].trim() : '';
}

// Resume shortlist: the newest STATE files in this cwd, newest first. No time
// window — age is shown to the operator rather than used to filter.
// `resolveLatestStatePath` is this with limit 1, collapsed to a path.
export function listStates(cwd, { limit = 3 } = {}) {
  // Same escape hatch every other resolver honours: an explicit override is the
  // only candidate.
  const override = process.env.CLAUDE_STATE_PATH;
  if (override) {
    if (!fs.existsSync(override)) return [];
    const parsed = parseStateName(path.basename(override))
      || { slug: '', sid: '', stamp: '', stampMs: 0 };
    return [{ ...parsed, path: override, summary: readStateSummary(override) }];
  }
  let entries = [];
  try { entries = fs.readdirSync(projectDir(cwd)); } catch { return []; }
  const out = [];
  for (const name of entries) {
    const parsed = parseStateName(name);
    if (!parsed) continue;
    out.push({ ...parsed, path: path.join(projectDir(cwd), name) });
  }
  out.sort((a, b) => (a.stamp < b.stamp ? 1 : a.stamp > b.stamp ? -1 : 0));
  return out.slice(0, limit).map(c => ({ ...c, summary: readStateSummary(c.path) }));
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

// Sibling docs directory for a resolved STATE path: appends `-docs` to the
// whole `slug_sid` blob (STATE_FILE_RE group 1) verbatim and unsplit — never
// attempts slug/sid decomposition, which is ambiguous once an unslugged sid
// contains underscores (sanitizeSid keeps them, sanitizeSlug strips them).
// Returns the sibling dir *name* (not a full path): the caller joins it with
// the STATE file's own directory, so it stays mechanically locked to whatever
// STATE file is being written this turn (no caller-supplied slug → no drift).
// Returns '' when the basename does not match STATE_FILE_RE, covering the
// CLAUDE_STATE_PATH override whose path need not follow the STATE shape.
export function docsDirForStatePath(statePath) {
  if (!statePath) return '';
  const m = path.basename(statePath).match(STATE_FILE_RE);
  if (!m) return '';
  return m[1] + '-docs';
}

// Absolute sibling docs dir for a resolved STATE path (docsDirForStatePath is
// only the dir *name*; the caller joins it to the STATE's own directory).
// '' when the STATE basename does not match STATE_FILE_RE (CLAUDE_STATE_PATH
// override), in which case callers skip the snapshot.
export function docsDirPath(statePath) {
  const name = docsDirForStatePath(statePath);
  return name ? path.join(path.dirname(statePath), name) : '';
}

// Header block (frontmatter) + the NEXT ACTIONS section of a STATE file,
// verbatim, truncated to maxChars with a pointer line when cut. '' when the
// file is unreadable. The frontmatter is the compaction-risky part a reader
// needs first; NEXT ACTIONS is the ordered resume list.
export function readStateHead(statePath, maxChars = Infinity) {
  let body = '';
  try { body = fs.readFileSync(statePath, 'utf8'); } catch { return ''; }
  const lines = body.split('\n');
  let headerEnd = -1;
  if (lines.length && lines[0].trim() === '---') {
    for (let i = 1; i < lines.length; i++) {
      if (lines[i].trim() === '---') { headerEnd = i; break; }
    }
  }
  const header = headerEnd >= 0 ? lines.slice(0, headerEnd + 1).join('\n') : '';
  let nextStart = -1;
  for (let i = 0; i < lines.length; i++) {
    if (/^## NEXT ACTIONS\b/.test(lines[i])) { nextStart = i; break; }
  }
  let section = '';
  if (nextStart >= 0) {
    let nextEnd = lines.length;
    for (let i = nextStart + 1; i < lines.length; i++) {
      if (/^## /.test(lines[i])) { nextEnd = i; break; }
    }
    section = lines.slice(nextStart, nextEnd).join('\n').replace(/\n+$/, '');
  }
  let out = [header, section].filter(Boolean).join('\n\n');
  if (out.length > maxChars) {
    const pointer = '\n…read the file for the rest';
    out = out.slice(0, Math.max(0, maxChars - pointer.length)).replace(/\n+$/, '') + pointer;
  }
  return out;
}

// Newest `precompact-<stamp>.md` in the docs dir, by filename stamp (they sort
// lexicographically). '' when the dir is missing or holds no snapshots.
export function latestPrecompactSnapshot(docsDir) {
  if (!docsDir) return '';
  let names;
  try { names = fs.readdirSync(docsDir); } catch { return ''; }
  const snaps = names
    .filter(n => /^precompact-\d{8}T\d{6}Z\.md$/.test(n))
    .sort();
  return snaps.length ? path.join(docsDir, snaps[snaps.length - 1]) : '';
}

// Rewrite (or insert) the `saved:` header field, keeping the file's own line
// endings. A file with no frontmatter block is left byte-identical: there is no
// header for the field to belong to.
function withSaved(body, stamp) {
  const eol = body.includes('\r\n') ? '\r\n' : '\n';
  const lines = body.split(/\r?\n/);
  if (!lines.length || lines[0].trim() !== '---') return body;
  let end = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === '---') { end = i; break; }
  }
  if (end < 0) return body;
  for (let i = 1; i < end; i++) {
    const m = lines[i].match(/^(\s*saved\s*:\s*).*$/);
    if (m) {
      lines[i] = m[1] + stamp;
      return lines.join(eol);
    }
  }
  let at = 1;
  for (let i = 1; i < end; i++) {
    if (/^\s*session\s*:/.test(lines[i])) { at = i + 1; break; }
  }
  lines.splice(at, 0, `saved: ${stamp}`);
  return lines.join(eol);
}

// Stamp a STATE file from the clock: rewrite `saved:` and embed the same instant
// in the filename, atomically. The free stamp is chosen before any write, so a
// crash leaves a complete file at one of the two names. A `CLAUDE_STATE_PATH`
// override is stamped in place; any other non-STATE path throws.
export function stampState(statePath, now = new Date()) {
  if (!statePath) throw new Error('stampState: path required');
  if (!fs.existsSync(statePath)) throw new Error(`stampState: source not found: ${statePath}`);
  const dir = path.dirname(statePath);
  const base = path.basename(statePath);
  const m = base.match(STATE_FILE_RE);
  const override = process.env.CLAUDE_STATE_PATH;
  const isOverride = !!override && path.resolve(override) === path.resolve(statePath);
  if (!m && !isOverride) throw new Error(`stampState: not a STATE file: ${base}`);

  let target = statePath;
  let at = now;
  // An override keeps its path — resolveOwnStatePath returns it verbatim, so a
  // rename would leave that escape hatch pointing at nothing.
  if (m && !isOverride) {
    target = '';
    // Bump by 1s on collision; cap at 60s to avoid runaway loops in degenerate cases.
    for (let i = 0; i < 60; i++) {
      const instant = new Date(now.getTime() + i * 1000);
      const candidate = path.join(dir, sessionStateFilename(m[1], nowStamp(instant)));
      if (!fs.existsSync(candidate)) { target = candidate; at = instant; break; }
    }
    if (!target) throw new Error(`stampState: could not find free stamp in 60s window for ${statePath}`);
  }

  const body = fs.readFileSync(statePath, 'utf8');
  const tmp = `${statePath}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  fs.writeFileSync(tmp, withSaved(body, savedStamp(at)), 'utf8');
  fs.renameSync(tmp, target);
  if (target !== statePath) fs.unlinkSync(statePath);
  return target;
}

export const renameStateToNow = stampState;

// The line pre-compact-snapshot.mjs stamps into every skeletal backstop, and
// the only way a reader can tell a skeleton from a real checkpoint.
export const SKELETON_MARKER = 'Skeletal backstop written by `pre-compact-snapshot.mjs`';

export function isSkeletonState(body) {
  return typeof body === 'string' && body.includes(SKELETON_MARKER);
}

// True if `body` has user-meaningful content (not empty, not just whitespace).
// Used by the snapshot hook to refuse self-clobber of a non-empty STATE.
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
    // Unique tmp: concurrent writers sharing one name rename each other's bytes.
    const tmp = `${p}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(obj, null, 2), 'utf8');
    fs.renameSync(tmp, p);
  } catch { /* non-fatal */ }
}

// Normalise a session entry; supports the legacy `<sid>: <number>` format.
export function getSessionState(state, sid) {
  const cur = state[sid];
  if (cur && typeof cur === 'object') return cur;
  if (typeof cur === 'number') return { lastSize: cur, userTs: 0, lastActivityTs: 0, lastTickTs: 0, lastInjectedDelay: 0, lastInjectTs: 0, injectPending: false };
  return { lastSize: 0, userTs: 0, lastActivityTs: 0, lastTickTs: 0, lastInjectedDelay: 0, lastInjectTs: 0, injectPending: false };
}

export function appendJSONL(p, obj) {
  try {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.appendFileSync(p, JSON.stringify(obj) + '\n', 'utf8');
  } catch { /* non-fatal */ }
}
