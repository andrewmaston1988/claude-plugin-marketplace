#!/usr/bin/env node
// SessionStart hook — on every fresh start (no STATE file required), instructs
// the agent how to find the project's STATE handoff (project dir + read the
// newest STATE*.md by filename date, with plain STATE.md as a fallback). When
// STATE files exist, it also hands over a shortlist of the newest ones for the
// agent to offer via AskUserQuestion. Fires only on source 'startup'|'clear'.
// Opt out via checkpoint.sessionStartResume=false. Never throws; exits 0 with
// optional additionalContext.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { listStates, readJSON, projectDir } from './lib/paths.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SETTINGS = path.join(os.homedir(), '.claude', 'settings.json');
const SUMMARY_CAP = 200;

export function isFreshSession(source) {
  return source === 'startup' || source === 'clear';
}

export function shouldOffer({ source, enabled, correlation }) {
  return enabled && !correlation && isFreshSession(source);
}

// Spelled out, not the terse `2h` form: this text lands in an option label the
// operator picks from.
export function longAge(stampMs, now) {
  const s = Math.max(0, Math.floor((now - stampMs) / 1000));
  const unit = (n, word) => `${n} ${word}${n === 1 ? '' : 's'} ago`;
  if (s < 60) return 'just now';
  if (s < 3600) return unit(Math.floor(s / 60), 'minute');
  if (s < 86400) return unit(Math.floor(s / 3600), 'hour');
  return unit(Math.floor(s / 86400), 'day');
}

export function optionLabel(candidate, now) {
  const name = candidate.slug || `session ${String(candidate.sid || '').slice(0, 8)}`;
  return `Resume ${name} (${longAge(candidate.stampMs, now)})`;
}

function summarise(text) {
  const t = String(text || '').replace(/\s+/g, ' ').trim();
  if (t.length <= SUMMARY_CAP) return t;
  return t.slice(0, SUMMARY_CAP).replace(/\s+\S*$/, '') + '\u2026';
}

// Render the resume-offer template. Always emits the find-instructions; when
// candidates exist, appends the shortlist and the instruction to ask. Hooks
// cannot call AskUserQuestion themselves — they can only hand over the options.
// Pure helper — exposed for testing.
export function renderResumeOffer({ template, dir, candidates = [], now = Date.now() }) {
  let shortlist = '';
  if (candidates.length) {
    const rows = candidates.map(c => {
      const s = summarise(c.summary);
      return `- ${optionLabel(c, now)} \u2014 \`${c.path}\`${s ? ` \u2014 ${s}` : ''}`;
    }).join('\n');
    shortlist = [
      '',
      '',
      'Before your first reply, ask which of these to resume using AskUserQuestion: one option '
      + 'per row below, using its label verbatim and its summary as the option description, plus '
      + 'a final "Start fresh" option. On a pick, read that file and continue from its `resume:` '
      + 'action. On "Start fresh", do not mention resuming again.',
      '',
      rows,
    ].join('\n');
  }
  return template
    .replace(/\{dir\}/g, dir || '')
    .replace(/\{shortlist\}/g, shortlist)
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

    if (!shouldOffer({ source, enabled, correlation })) process.exit(0);

    let candidates = [];
    try { candidates = listStates(cwd, { limit: 3 }); } catch { /* no STATE_* */ }

    let tmpl = '';
    try { tmpl = fs.readFileSync(path.join(HERE, 'templates', 'resume-offer.md'), 'utf8'); } catch {}
    let dir = '';
    try { dir = projectDir(cwd); } catch {}

    const text = renderResumeOffer({ template: tmpl, dir, candidates, now: Date.now() });
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
