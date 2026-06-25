#!/usr/bin/env node
// SessionStart hook — on every fresh start (no STATE file required), instructs
// the agent how to find the project's STATE handoff (project dir + read the
// newest STATE*.md by filename date, with plain STATE.md as a fallback). When
// a per-session file already exists, the offer also surfaces its path + age as
// the current best match. Fires only on source 'startup'|'clear'. Opt out via
// checkpoint.sessionStartResume=false. Never throws; exits 0 with optional
// additionalContext.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { resolveLatestStatePath, readJSON, projectDir } from './lib/paths.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SETTINGS = path.join(os.homedir(), '.claude', 'settings.json');

export function isFreshSession(source) {
  return source === 'startup' || source === 'clear';
}

export function shouldOffer({ source, enabled, correlation }) {
  return enabled && !correlation && isFreshSession(source);
}

export function relativeAge(mtimeMs, now) {
  const s = Math.max(0, Math.floor((now - mtimeMs) / 1000));
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

// Render the resume-offer template. Always emits the find-instructions
// (project dir + newest STATE*.md by filename date, plain STATE.md fallback);
// when `statePath` is non-empty, also surfaces that path + age as the current
// best match. Pure helper — exposed for testing.
export function renderResumeOffer({ template, dir, statePath, mtimeMs, now = Date.now() }) {
  const pathSurplus = statePath
    ? ` Current best match: \`${statePath}\` (from ${relativeAge(mtimeMs, now)}).`
    : '';
  return template
    .replace(/\{dir\}/g, dir || '')
    .replace(/\{path_surplus\}/g, pathSurplus)
    .trim();
}

function main() {
  let stdin = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', c => { stdin += c; });
  process.stdin.on('end', () => {
    let payload = {};
    try { payload = JSON.parse(stdin); } catch { process.exit(0); }

    const source = String(payload.source || 'startup');
    const cwd = String(payload.cwd || process.cwd());

    const settings = readJSON(SETTINGS, {});
    const enabled = settings?.['checkpoint']?.sessionStartResume !== false; // default on
    const correlation = !!process.env.CORRELATION_ID;

    let statePath = '', mtimeMs = 0;
    try {
      statePath = resolveLatestStatePath(cwd);
      if (statePath) {
        const st = fs.statSync(statePath);
        mtimeMs = st.mtimeMs;
      }
    } catch { /* no STATE_* */ }

    if (!shouldOffer({ source, enabled, correlation })) process.exit(0);

    let tmpl = '';
    try { tmpl = fs.readFileSync(path.join(HERE, 'templates', 'resume-offer.md'), 'utf8'); } catch {}
    let dir = '';
    try { dir = projectDir(cwd); } catch {}
    const text = renderResumeOffer({
      template: tmpl,
      dir,
      statePath,
      mtimeMs,
      now: Date.now(),
    });

    if (text) {
      process.stdout.write(JSON.stringify({
        hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: text },
      }) + '\n');
    }
    process.exit(0);
  });
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}