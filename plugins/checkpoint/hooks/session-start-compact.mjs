#!/usr/bin/env node
// SessionStart hook, source 'compact' only: points the agent at this session's
// STATE file while the post-compact summary is still in context. The event is
// the session scoping — a shared on-disk flag cannot tell which session
// compacted. Opt out via checkpoint.sessionStartResume=false. Never throws.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { pathToFileURL } from 'node:url';
import { readJSON, resolveOwnStatePath, isMeaningfulState, isSkeletonState } from './lib/paths.mjs';
import { SKILL_INVOCATION, SKILL_DISAMBIGUATION } from './lib/skill-ref.mjs';

const SETTINGS = path.join(os.homedir(), '.claude', 'settings.json');

export function shouldPickUp({ source, enabled, correlation }) {
  return enabled && !correlation && source === 'compact';
}

// PreCompact skips the write when a real checkpoint already exists, so the note
// must read the file rather than assume a skeleton was just written. No sid means
// no per-session path at all, which is not the same as the file being absent —
// several sessions can share a cwd, each with its own STATE.
export function classifyState(statePath) {
  if (!statePath) return 'unresolved';
  if (!fs.existsSync(statePath)) return 'none';
  let body;
  // Present but unreadable is not absent — don't claim there is no STATE.
  try { body = fs.readFileSync(statePath, 'utf8'); } catch { return 'unresolved'; }
  if (!isMeaningfulState(body)) return 'none';
  return isSkeletonState(body) ? 'skeleton' : 'rich';
}

export function buildPickupNote(kind, statePath) {
  const lead = '**This session just compacted.** ';
  const tail = ` While your post-compact summary is still in context, call ${SKILL_INVOCATION} `;
  if (kind === 'skeleton') {
    return lead + `The PreCompact backstop wrote a skeletal STATE at \`${statePath}\`.`
      + tail + `to reconcile it into a rich version. ${SKILL_DISAMBIGUATION}`;
  }
  if (kind === 'rich') {
    return lead + `This session's STATE is at \`${statePath}\` — it already holds a full `
      + 'checkpoint, so the PreCompact backstop left it alone.'
      + tail + `to reconcile it against what just happened. ${SKILL_DISAMBIGUATION}`;
  }
  if (kind === 'none') {
    return lead + 'No STATE file exists for this session.'
      + tail + `to write one. ${SKILL_DISAMBIGUATION}`;
  }
  return lead + "This session's STATE file could not be resolved."
    + tail + `to check for one and bring it up to date. ${SKILL_DISAMBIGUATION}`;
}

function main() {
  let stdin = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', c => { stdin += c; });
  process.stdin.on('end', () => {
    let payload = {};
    try { payload = JSON.parse(stdin); } catch { process.exit(0); }

    const settings = readJSON(SETTINGS, {});
    const enabled = settings?.['checkpoint']?.sessionStartResume !== false; // default on

    if (!shouldPickUp({
      source: String(payload.source || ''),
      enabled,
      correlation: !!process.env.CORRELATION_ID,
    })) process.exit(0);

    let statePath = '';
    try { statePath = resolveOwnStatePath(payload.cwd || '', payload.session_id || ''); } catch {}
    const kind = classifyState(statePath);

    process.stdout.write(JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'SessionStart',
        additionalContext: buildPickupNote(kind, statePath),
      },
    }) + '\n');
    process.exit(0);
  });
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
