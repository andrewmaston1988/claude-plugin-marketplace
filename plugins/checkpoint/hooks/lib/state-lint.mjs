#!/usr/bin/env node
// Deterministic shape lint for a checkpoint STATE file. It judges shape, not
// truth; the messages are the teaching surface, so one round trip reaches green.
// CLI: node hooks/lib/state-lint.mjs <path>  (exit 0 pass, 1 fail)
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { docsDirPath, SAVED_RE, SAVED_EXAMPLE } from './paths.mjs';

// Bounds measured over the 148 rich STATE files on this machine; the median
// file passes every one. One source: the template quotes them, and a test pins
// the two together.
export const RESUME_MAX = 400;
export const SESSION_MAX = 300;
export const FILE_MAX = 40_000;
export const SECTION_MAX = 8_000;

export { SAVED_RE, SAVED_EXAMPLE };

export const SECTIONS = [
  'OBJECTIVE',
  'CURRENT STATE',
  'NEXT ACTIONS',
  'CONSTRAINTS & DECISIONS',
  'ENV & COMMANDS',
  'KEY FILES',
  'OUT OF SCOPE',
];

// The sections a checkpoint must rewrite from current reality.
export const LIVE_SECTIONS = ['CURRENT STATE', 'NEXT ACTIONS', 'KEY FILES'];

const nfmt = (n) => n.toLocaleString('en-US');

function normaliseSpace(s) {
  return String(s || '').replace(/\s+/g, ' ').trim();
}

function parseFrontmatter(lines) {
  if (!lines.length || lines[0].trim() !== '---') return null;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === '---') return { start: 1, end: i };
  }
  return null;
}

// Fields inside the frontmatter block. A non-empty line that is not `name:`
// continues the previous field — a continuation is the header-as-log symptom.
function parseFields(lines, fm) {
  const fields = new Map();
  if (!fm) return fields;
  let current = null;
  for (let i = fm.start; i < fm.end; i++) {
    const line = lines[i];
    if (!line.trim()) continue;
    const m = line.match(/^([A-Za-z][A-Za-z0-9_-]*)\s*:(.*)$/);
    if (m) {
      current = { name: m[1].toLowerCase(), value: m[2].trim(), extra: 0 };
      fields.set(current.name, current);
    } else if (current) {
      current.extra += 1;
    }
  }
  return fields;
}

// The section name, ignoring padding and the [live]/[stable] tag: the corpus
// carries both `## CURRENT STATE          [live]` and bare `## CURRENT STATE`.
function headingName(line) {
  const m = line.match(/^##\s+(.+?)\s*$/);
  if (!m) return '';
  return m[1].replace(/\s*\[(?:live|stable)\]\s*$/i, '').replace(/\s+/g, ' ').trim();
}

function parseSections(lines) {
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const name = headingName(lines[i]);
    if (!name) continue;
    out.push({ name, key: name.toUpperCase(), start: i, end: lines.length });
  }
  for (let i = 0; i < out.length - 1; i++) out[i].end = out[i + 1].start;
  return out;
}

// First numbered/bulleted item in a section's body.
function firstListItem(lines) {
  for (const line of lines) {
    const m = line.match(/^\s*(?:\d+[.)]|[-*])\s+(.+)$/);
    if (m) return m[1].trim();
  }
  return '';
}

// Docs-dir files the STATE names as `<docsDir>/<name>` or `<docsDirName>/<name>`.
// Both separator styles count: a win32 header writes backslashes, a link may
// write forward ones.
function namedDocsFiles(body, docsDir) {
  const text = body.replace(/\\/g, '/');
  const dir = docsDir.replace(/\\/g, '/').replace(/\/+$/, '');
  const base = dir.slice(dir.lastIndexOf('/') + 1);
  const names = new Set();
  for (const needle of new Set([dir, base])) {
    if (!needle) continue;
    let from = 0;
    for (;;) {
      const at = text.indexOf(needle, from);
      if (at < 0) break;
      from = at + needle.length;
      const m = text.slice(from).match(/^\/([A-Za-z0-9._-]+\.[A-Za-z0-9]+)/);
      if (m) names.add(m[1]);
    }
  }
  return [...names];
}

function normaliseBody(s) {
  return String(s).replace(/\r\n?/g, '\n')
    .split('\n').map(l => l.replace(/\s+$/, '')).join('\n').trim();
}

// Hash of the three live sections' content, with the heading, its padding and
// its tag excluded. The Stop hook uses it to tell a real reconcile from a
// header-only touch.
export function liveSectionsHash(text) {
  const lines = String(text ?? '').split(/\r?\n/);
  const byKey = new Map(parseSections(lines).map(s => [s.key, s]));
  const parts = LIVE_SECTIONS.map((name) => {
    const s = byKey.get(name);
    return s ? normaliseBody(lines.slice(s.start + 1, s.end).join('\n')) : '';
  });
  return createHash('sha256').update(parts.join('\n\u0000\n')).digest('hex');
}

// `docsFiles` is the docs dir's basename listing, injected so the core stays
// pure. `docsDir` is the absolute sibling dir (docsDirPath) or ''.
export function lintState(text, { docsDir = '', docsFiles = [] } = {}) {
  const body = String(text ?? '');
  const lines = body.split(/\r?\n/);
  const fm = parseFrontmatter(lines);
  const fields = parseFields(lines, fm);
  const sections = parseSections(lines);
  const byKey = new Map(sections.map(s => [s.key, s]));
  const docsRef = docsDir || 'the sibling docs dir';
  const errors = [];

  // Header fields: one line each, within budget.
  for (const [name, cap] of [['session', SESSION_MAX], ['resume', RESUME_MAX]]) {
    const f = fields.get(name);
    if (!f) {
      errors.push(`${name}: header field is missing — fix: write one line in the frontmatter — e.g. ${name}: <one line>`);
    } else if (f.extra > 0) {
      errors.push(`${name}: header field is a log (${f.extra} continuation line${f.extra === 1 ? '' : 's'}) — fix: keep it to one line, file the detail under ${docsRef} and link it — e.g. ${name}: <one line>`);
    } else if (f.value.length > cap) {
      errors.push(`${name}: ${nfmt(f.value.length)} characters, over the ${nfmt(cap)}-character limit — fix: cut it to the single next step; detail belongs in NEXT ACTIONS or a linked doc — e.g. ${name}: <one line>`);
    }
  }

  // `saved:` is written by the clock, never by hand.
  const savedField = fields.get('saved');
  if (!savedField) {
    errors.push(`saved: header field is missing — fix: run stampState so the clock writes it — e.g. saved: ${SAVED_EXAMPLE}`);
  } else if (savedField.extra > 0) {
    errors.push(`saved: header field is a log (${savedField.extra} continuation line${savedField.extra === 1 ? '' : 's'}) — fix: run stampState so the clock writes it — e.g. saved: ${SAVED_EXAMPLE}`);
  } else if (!SAVED_RE.test(savedField.value)) {
    const shown = savedField.value.length > 60 ? savedField.value.slice(0, 57) + '...' : savedField.value;
    errors.push(`saved: "${shown}" is not the clock form — fix: run stampState, never write it by hand — e.g. saved: ${SAVED_EXAMPLE}`);
  }

  // The seven sections, matched by name and kept in template order.
  let prev = -1;
  for (let i = 0; i < SECTIONS.length; i++) {
    const name = SECTIONS[i];
    const s = byKey.get(name);
    if (!s) {
      errors.push(`sections: missing "## ${name}" — fix: write the seven template sections in order — e.g. ## ${name} [${LIVE_SECTIONS.includes(name) ? 'live' : 'stable'}]`);
      continue;
    }
    if (s.start < prev) {
      errors.push(`sections: "## ${name}" comes before "## ${SECTIONS[i - 1]}" — fix: keep the seven sections in template order — e.g. move "## ${name}" after "## ${SECTIONS[i - 1]}"`);
    }
    prev = Math.max(prev, s.start);
  }

  // Size budgets: an over-budget file is no longer readable in one Read.
  if (body.length > FILE_MAX) {
    errors.push(`file: ${nfmt(body.length)} characters, over the ${nfmt(FILE_MAX)}-character budget — fix: move the narrative to ${docsRef} and link it under KEY FILES — e.g. - ${docsRef}/<name>.md — why it matters`);
  }
  for (const s of sections) {
    const size = lines.slice(s.start, s.end).join('\n').length;
    if (size > SECTION_MAX) {
      errors.push(`section "${s.name}": ${nfmt(size)} characters, over the ${nfmt(SECTION_MAX)}-character limit — fix: file it under ${docsRef} and link it from KEY FILES — e.g. - ${docsRef}/<name>.md — why it matters`);
    }
  }

  // Durable narrative lives in the docs dir: every file there is linked, and
  // every linked docs path exists. Snapshots are the hooks' own writes.
  if (docsDir) {
    for (const name of docsFiles.filter(n => !/^precompact-/.test(n))) {
      if (!body.includes(name)) {
        errors.push(`docs: "${name}" in ${docsDir} is never named by the STATE — fix: link it under KEY FILES as "path — hook", or move it out of the docs dir — e.g. - ${docsDir}/${name} — why it matters`);
      }
    }
    for (const name of namedDocsFiles(body, docsDir)) {
      if (!docsFiles.includes(name)) {
        errors.push(`docs: "${name}" is named but does not exist in ${docsDir} — fix: link the real file, or drop the reference — e.g. - ${docsDir}/${name} — why it matters`);
      }
    }
  }

  // `resume:` mirrors the start of NEXT ACTIONS #1, whitespace-normalised: a
  // fresh resume line over a stale list is a mismatch.
  const resumeField = fields.get('resume');
  const next = byKey.get('NEXT ACTIONS');
  if (resumeField && !resumeField.extra && resumeField.value && next) {
    const item = firstListItem(lines.slice(next.start + 1, next.end));
    if (!item) {
      errors.push(`resume: NEXT ACTIONS has no item #1 to mirror — fix: start it with "1. <the resume action>" — e.g. 1. ${resumeField.value}`);
    } else if (!normaliseSpace(item).startsWith(normaliseSpace(resumeField.value))) {
      const want = normaliseSpace(item).slice(0, 80);
      const got = normaliseSpace(resumeField.value).slice(0, 80);
      errors.push(`resume: "${got}" is not the start of NEXT ACTIONS #1 ("${want}") — fix: make the header line the start of item 1 — e.g. resume: ${want}`);
    }
  }

  return { errors };
}

function main() {
  const target = process.argv[2];
  if (!target) {
    process.stderr.write('usage: node hooks/lib/state-lint.mjs <path>\n');
    process.exit(1);
  }
  let text = '';
  try {
    text = fs.readFileSync(target, 'utf8');
  } catch {
    process.stderr.write(`state-lint: cannot read ${target}\n`);
    process.exit(1);
  }
  const docsDir = docsDirPath(target);
  let docsFiles = [];
  if (docsDir) {
    try { docsFiles = fs.readdirSync(docsDir); } catch { /* no docs dir yet */ }
  }
  const { errors } = lintState(text, { docsDir, docsFiles });
  if (errors.length) {
    process.stdout.write(errors.join('\n') + '\n');
    process.exit(1);
  }
  process.exit(0);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
