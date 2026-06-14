#!/usr/bin/env node
// Composable statusline segment: prints 🔥 (warm) / ❄️ (busted/cold) + context %.
// Reads the statusline JSON on stdin (needs transcript_path + model). Ambient, not an alert.
import { cacheState, readRecentAssistantTurns, contextUtilization, contextWindowFor } from '../hooks/lib/context.mjs';

let stdin = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', c => { stdin += c; });
process.stdin.on('end', () => {
  let p = {};
  try { p = JSON.parse(stdin); } catch {}
  const transcriptPath = p.transcript_path || '';
  const turns = transcriptPath ? readRecentAssistantTurns(transcriptPath, 1) : [];
  const last = turns[turns.length - 1];
  if (!last) { process.stdout.write(''); process.exit(0); }
  const glyph = { warm: '🔥', busted: '❄️', cold: '❄️' }[cacheState(last.usage)];
  const model = (p.model && (p.model.id || p.model)) || last.model;
  const pct = contextUtilization(last.usage, contextWindowFor(model));
  process.stdout.write(`${glyph} ${pct}%`);
  process.exit(0);
});
