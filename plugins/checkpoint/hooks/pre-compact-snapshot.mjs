#!/usr/bin/env node
// PreCompact hook: writes a skeletal STATE.md backstop. Always exits 0.

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { pathToFileURL } from 'node:url';

const MARKER = path.join(os.homedir(), '.claude', '.compact_just_ran');
// Don't clobber a Claude-authored STATE.md modified within this window;
// treat anything older as stale and worth overwriting with at least a fresh skeleton.
const FRESH_STATE_MTIME_WINDOW_SECONDS = 3600;
// Read this much from the end of the JSONL — enough to find the last user/assistant
// pair + recent tool uses without slurping multi-MB transcripts.
const TRANSCRIPT_TAIL_BYTES = 250_000;
const LAST_TEXT_CHARS = 500;
const LAST_TOOL_USES = 10;

// ---- path resolution ----
function encodeProject(p) {
  return p.replace(/[\\/:]/g, '-');
}
function resolveStatePath(cwd, flag) {
  if (flag) return flag;
  if (process.env.CLAUDE_STATE_PATH) return process.env.CLAUDE_STATE_PATH;
  return path.join(os.homedir(), '.claude', 'projects', encodeProject(cwd), 'STATE.md');
}

// ---- argv: read flags from process.argv (--state-path X) ----
let stateFlag = null;
const args = process.argv.slice(2);
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--state-path' && i + 1 < args.length) stateFlag = args[++i];
}

// ---- transcript-tail reader ----
function readTranscriptTail(transcriptPath) {
  try {
    const stat = fs.statSync(transcriptPath);
    const fd = fs.openSync(transcriptPath, 'r');
    const start = Math.max(0, stat.size - TRANSCRIPT_TAIL_BYTES);
    const buf = Buffer.alloc(stat.size - start);
    try { fs.readSync(fd, buf, 0, buf.length, start); } finally { try { fs.closeSync(fd); } catch {} }
    const text = buf.toString('utf8');
    const entries = [];
    for (const line of text.split('\n')) {
      const t = line.trim();
      if (!t) continue;
      try { entries.push(JSON.parse(t)); } catch { /* skip partial first line */ }
    }
    return entries;
  } catch { return []; }
}

function extractText(entry, role) {
  const msg = entry && entry.message;
  if (!msg || msg.role !== role) return '';
  if (typeof msg.content === 'string') return msg.content;
  if (Array.isArray(msg.content)) {
    return msg.content
      .filter(b => b && b.type === 'text')
      .map(b => b.text || '')
      .join('\n');
  }
  return '';
}

function extractToolUses(entry) {
  const msg = entry && entry.message;
  if (!msg || msg.role !== 'assistant' || !Array.isArray(msg.content)) return [];
  const out = [];
  for (const blk of msg.content) {
    if (!blk || blk.type !== 'tool_use') continue;
    const name = blk.name || '?';
    const inp = blk.input || {};
    let summary = '';
    for (const key of ['command', 'file_path', 'query', 'pattern', 'path', 'skill', 'description']) {
      const v = inp[key];
      if (typeof v === 'string') { summary = v.slice(0, 120); break; }
    }
    out.push({ name, summary });
  }
  return out;
}

export function buildSkeleton(entries, trigger, sid, cwd, size) {
  let lastUser = '', lastAssistant = '';
  for (let i = entries.length - 1; i >= 0; i--) {
    if (!lastAssistant) { const t = extractText(entries[i], 'assistant'); if (t) lastAssistant = t; }
    if (!lastUser)      { const t = extractText(entries[i], 'user');      if (t) lastUser = t; }
    if (lastUser && lastAssistant) break;
  }
  const toolUses = entries.flatMap(extractToolUses).slice(-LAST_TOOL_USES);
  const ts = new Date().toISOString().slice(0, 19).replace('T', ' ');
  const sidShort = (sid || '?').slice(0, 12);

  const lines = [
    `# STATE.md (auto-snapshot before ${trigger} compaction at ${ts})`,
    '',
    '_Skeletal backstop written by `pre-compact-snapshot.mjs`. Invoke the `checkpoint` skill after compaction to reconcile it into a rich version._',
    '',
    '## Session',
    `- session_id: \`${sidShort}\``,
    `- cwd: \`${cwd}\``,
    `- transcript size at snapshot: ${size.toLocaleString()} bytes`,
    `- trigger: ${trigger}`,
    '',
    '## Last user message (first 500 chars)',
    '```',
    (lastUser.slice(0, LAST_TEXT_CHARS) || '(none captured)'),
    '```',
    '',
    '## Last assistant message (first 500 chars)',
    '```',
    (lastAssistant.slice(0, LAST_TEXT_CHARS) || '(none captured)'),
    '```',
    '',
    `## Recent tool uses (last ${LAST_TOOL_USES})`,
  ];
  if (toolUses.length) {
    for (const tu of toolUses) lines.push(`- **${tu.name}**: ${tu.summary || '(no summary)'}`);
  } else {
    lines.push('- (none captured)');
  }
  lines.push('');
  return lines.join('\n');
}

// ---- main ----
function main() {
  let stdin = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', c => { stdin += c; });
  process.stdin.on('end', () => {
    let payload = {};
    try { payload = JSON.parse(stdin); } catch { /* no payload → silent exit */ }

    const transcriptPath = payload.transcript_path || '';
    const cwd = payload.cwd || '';
    const sid = payload.session_id || '';
    const trigger = payload.trigger || 'auto';

    // Always touch the marker so a UserPromptSubmit hook (if wired) can pick it up
    try {
      fs.mkdirSync(path.dirname(MARKER), { recursive: true });
      fs.writeFileSync(MARKER, String(Date.now()));
    } catch { /* non-fatal */ }

    if (!cwd) process.exit(0);

    let statePath;
    try { statePath = resolveStatePath(cwd, stateFlag); }
    catch { process.exit(0); }

    // Don't clobber a fresh Claude-authored STATE.md
    try {
      if (fs.existsSync(statePath)) {
        const ageSec = (Date.now() - fs.statSync(statePath).mtimeMs) / 1000;
        if (ageSec < FRESH_STATE_MTIME_WINDOW_SECONDS) process.exit(0);
      }
    } catch { /* fall through */ }

    let size = 0;
    try { if (transcriptPath) size = fs.statSync(transcriptPath).size; } catch {}

    const entries = transcriptPath ? readTranscriptTail(transcriptPath) : [];
    try {
      const body = buildSkeleton(entries, trigger, sid, cwd, size);
      fs.mkdirSync(path.dirname(statePath), { recursive: true });
      fs.writeFileSync(statePath, body, 'utf8');
    } catch { /* never block compaction */ }

    process.exit(0);
  });
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
