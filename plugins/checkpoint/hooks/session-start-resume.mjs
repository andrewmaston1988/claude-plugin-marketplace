#!/usr/bin/env node
// SessionStart hook — offers (does not auto-load) a STATE.md resume on a fresh start.
// Fires only on source 'startup'|'clear'. Opt out via checkpoint.sessionStartResume=false.
// Never throws; exits 0 with optional additionalContext.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { resolveStatePath, readJSON } from './lib/paths.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SETTINGS = path.join(os.homedir(), '.claude', 'settings.json');

export function isFreshSession(source) {
  return source === 'startup' || source === 'clear';
}

export function shouldOffer({ source, enabled, correlation, stateExists }) {
  return enabled && !correlation && isFreshSession(source) && stateExists;
}

export function relativeAge(mtimeMs, now) {
  const s = Math.max(0, Math.floor((now - mtimeMs) / 1000));
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
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

    let statePath, stateExists = false, mtimeMs = 0;
    try {
      statePath = resolveStatePath(cwd);
      const st = fs.statSync(statePath);
      stateExists = true;
      mtimeMs = st.mtimeMs;
    } catch { /* no STATE.md */ }

    if (!shouldOffer({ source, enabled, correlation, stateExists })) process.exit(0);

    let tmpl = '';
    try { tmpl = fs.readFileSync(path.join(HERE, 'templates', 'resume-offer.md'), 'utf8'); } catch {}
    const text = tmpl
      .replace(/\{age\}/g, relativeAge(mtimeMs, Date.now()))
      .replace(/\{path\}/g, statePath)
      .trim();

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
