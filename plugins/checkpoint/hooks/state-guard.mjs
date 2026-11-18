#!/usr/bin/env node
// PreToolUse hook: hold an acting call while a resumed STATE file is still
// partly unread, and record the round's pre-image on the first write.
// hooks.json's matcher sends only acting tools, so a Read or Grep never pays a
// node start here. Fails open on anything — a guard that bricks a session is
// worse than none.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { readJSON } from './lib/paths.mjs';
import { onPreToolUse } from './lib/state-guard.mjs';

const SETTINGS = path.join(os.homedir(), '.claude', 'settings.json');

function main() {
  let stdin = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', c => { stdin += c; });
  process.stdin.on('end', () => {
    let payload = {};
    try { payload = JSON.parse(stdin); } catch { process.exit(0); }
    let decision = null;
    try {
      decision = onPreToolUse(payload, { _settings: readJSON(SETTINGS, {}) });
    } catch { /* fail open */ }
    if (decision) process.stdout.write(JSON.stringify(decision) + '\n');
    process.exit(0);
  });
  process.stdin.on('error', () => process.exit(0));
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
