// A fixture of Claude Code's cached model catalog, written under a throwaway
// HOME: no test in this suite may read the operator's real ~/.claude.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// The windows Claude Code ships for these ids: every current Claude model is 1M
// except Haiku 4.5, which is 200k.
export const CLAUDE_CATALOG = [
  { id: 'claude-opus-5-5', name: 'Opus 5.5', runtime: { max_input_tokens: 1_000_000 } },
  { id: 'claude-sonnet-5-5', name: 'Sonnet 5.5', runtime: { max_input_tokens: 1_000_000 } },
  { id: 'claude-haiku-4-5-20251001', name: 'Haiku 4.5', runtime: { max_input_tokens: 200_000 } },
];

export const CATALOG_DIR = '.claude/cache/model-catalog';

export function catalogHome(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ckpt-catalog-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

export function writeCatalog(home, { rows = CLAUDE_CATALOG, fetchedAt = 1, name = 'fixture-cc.json' } = {}) {
  const file = path.join(home, CATALOG_DIR, name);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ fetchedAt, catalog: { config: { models: rows } } }), 'utf8');
  return file;
}
