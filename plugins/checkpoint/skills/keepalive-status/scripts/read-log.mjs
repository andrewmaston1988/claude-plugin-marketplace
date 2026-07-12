#!/usr/bin/env node
// Reads the keepalive tick log + recent transcript usage and prints a health summary.
// States explicitly whether keepalive is enabled, so the skill can offer to turn it on.
// Usage: node read-log.mjs [transcript_path]
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { KEEPALIVE_LOG, readJSON } from '../../../hooks/lib/paths.mjs';
import { cacheState, readRecentAssistantTurns } from '../../../hooks/lib/context.mjs';

const SETTINGS = path.join(os.homedir(), '.claude', 'settings.json');
const enabled = readJSON(SETTINGS, {})?.['checkpoint']?.keepalive === true;

function readTicks(limit = 50) {
  try {
    const lines = fs.readFileSync(KEEPALIVE_LOG, 'utf8').trim().split('\n').filter(Boolean);
    return lines.slice(-limit).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  } catch { return []; }
}

console.log(enabled
  ? 'keepalive: ENABLED'
  : 'keepalive: DISABLED (set "checkpoint": { "keepalive": true } in ~/.claude/settings.json)');

const ticks = readTicks();
if (ticks.length) {
  const gaps = ticks.map(t => t.observedGap).filter(n => n > 0);
  const min = gaps.length ? Math.min(...gaps) : 0;
  const max = gaps.length ? Math.max(...gaps) : 0;
  const avg = gaps.length ? Math.round(gaps.reduce((a, b) => a + b, 0) / gaps.length) : 0;
  const lastTtl = ticks[ticks.length - 1].ttlSecs || 300;
  console.log(`  ticks: ${ticks.length} | cadence min/avg/max = ${min}/${avg}/${max}s | ttl (latest tick) = ${lastTtl}s`);
  const overTTL = ticks.filter(t => (t.observedGap || 0) > (t.ttlSecs || 300)).length;
  console.log(overTTL ? `  ⚠️ ${overTTL} tick gap(s) exceeded the cache TTL` : `  ✅ all tick gaps under TTL`);
} else {
  console.log(enabled ? '  no ticks logged yet (chain not fired this session)' : '  no ticks logged (keepalive is off)');
}

const transcriptPath = process.argv[2];
if (transcriptPath) {
  const turns = readRecentAssistantTurns(transcriptPath, 10);
  const states = turns.map(t => cacheState(t.usage));
  const busts = states.filter(s => s === 'busted').length;
  console.log(`  recent cache state: ${states.join(' ') || '(none)'} | busts: ${busts}`);
}
