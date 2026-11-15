#!/usr/bin/env node
// PreCompact hook: writes a skeletal STATE_<sid>_<stamp>.md backstop for the
// OWN session only. Always exits 0.

import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { resolveOwnStatePath, isMeaningfulState, SKELETON_MARKER, docsDirPath, nowStamp } from './lib/paths.mjs';
import { SKILL_ID, SKILL_DISAMBIGUATION } from './lib/skill-ref.mjs';

// Read this much from the end of the JSONL — enough to find the last user/assistant
// pair + recent tool uses without slurping multi-MB transcripts.
const TRANSCRIPT_TAIL_BYTES = 250_000;
const LAST_TEXT_CHARS = 500;
const LAST_TOOL_USES = 10;

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
    `_${SKELETON_MARKER}. After compaction, call the Skill tool with skill="${SKILL_ID}" to reconcile it into a rich version. ${SKILL_DISAMBIGUATION}_`,
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

// Stdout is instructions to the summariser. Budgeted: the read-first sentence
// and the STATE path always survive; the quoted resume: line absorbs the cuts.
const SUMMARY_INSTRUCTIONS_LIMIT = 10_000;

export function buildSummaryInstructions(statePath, snapshotPath, stateBody) {
  const readFirst = `After compaction, the first action is to Read \`${statePath}\` in full. It is the checkpoint for this session; do not rewrite it from the summary.`;
  let out = readFirst;
  if (snapshotPath) {
    out += `\nA pre-compact snapshot with the last messages and tool uses is at \`${snapshotPath}\`.`;
  }
  const m = typeof stateBody === 'string' ? stateBody.match(/^resume:\s*(.+)$/m) : null;
  if (m) {
    const prefix = '\nresume: "';
    // -1 for the closing quote, -1 for the trailing newline added at return.
    const remaining = SUMMARY_INSTRUCTIONS_LIMIT - out.length - prefix.length - 2;
    if (remaining > 0) {
      const line = m[1].trim();
      out += prefix + (line.length <= remaining ? line : line.slice(0, remaining)) + '"';
    }
  }
  return out + '\n';
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

    if (!cwd) process.exit(0);

    let statePath;
    try { statePath = stateFlag || resolveOwnStatePath(cwd, sid); }
    catch { process.exit(0); }
    if (!statePath) process.exit(0); // no session_id → nothing per-session to write

    let stateBody = null;
    try { if (fs.existsSync(statePath)) stateBody = fs.readFileSync(statePath, 'utf8'); } catch { /* unreadable → skeleton path */ }

    // A full checkpoint is never overwritten. Instead the snapshot lands as a
    // sibling precompact-<stamp>.md in the docs dir; '' (e.g. a CLAUDE_STATE_PATH
    // override) skips it entirely.
    const hasFullCheckpoint = stateBody !== null && isMeaningfulState(stateBody);

    let size = 0;
    try { if (transcriptPath) size = fs.statSync(transcriptPath).size; } catch {}

    const entries = transcriptPath ? readTranscriptTail(transcriptPath) : [];
    let snapshotPath = '';
    if (hasFullCheckpoint) {
      const dir = docsDirPath(statePath);
      if (dir) {
        const candidate = path.join(dir, `precompact-${nowStamp()}.md`);
        try {
          fs.mkdirSync(dir, { recursive: true });
          const body = `# Pre-compact snapshot at ${new Date().toISOString().slice(0, 19).replace('T', ' ')}\n\n`
            + buildSkeleton(entries, trigger, sid, cwd, size);
          fs.writeFileSync(candidate, body, 'utf8');
          snapshotPath = candidate;
        } catch { /* snapshot is best-effort; never block compaction */ }
      }
    } else {
      try {
        const body = buildSkeleton(entries, trigger, sid, cwd, size);
        fs.mkdirSync(path.dirname(statePath), { recursive: true });
        fs.writeFileSync(statePath, body, 'utf8');
      } catch { /* never block compaction */ }
    }

    process.stdout.write(buildSummaryInstructions(statePath, snapshotPath, stateBody || ''));
    process.exit(0);
  });
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
