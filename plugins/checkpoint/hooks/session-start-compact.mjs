#!/usr/bin/env node
// SessionStart hook, source 'compact' only: tells the agent to reconcile the
// skeletal STATE the PreCompact backstop just wrote, while the post-compact
// summary is still in context. The event is the session scoping — a shared
// on-disk flag cannot tell which session compacted. Opt out via
// checkpoint.sessionStartResume=false. Never throws.
import path from 'node:path';
import os from 'node:os';
import { pathToFileURL } from 'node:url';
import { readJSON } from './lib/paths.mjs';
import { SKILL_INVOCATION, SKILL_DISAMBIGUATION } from './lib/skill-ref.mjs';

const SETTINGS = path.join(os.homedir(), '.claude', 'settings.json');

export function shouldPickUp({ source, enabled, correlation }) {
  return enabled && !correlation && source === 'compact';
}

export function buildPickupNote() {
  return '**This session just compacted.** A skeletal STATE.md was written by the PreCompact '
    + 'backstop. While your post-compact summary is still in context, call '
    + `${SKILL_INVOCATION} to reconcile it into a richer STATE.md. ${SKILL_DISAMBIGUATION}`;
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

    process.stdout.write(JSON.stringify({
      hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: buildPickupNote() },
    }) + '\n');
    process.exit(0);
  });
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
