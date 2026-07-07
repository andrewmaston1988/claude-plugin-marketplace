import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { renameStateToNow } from '../lib/paths.mjs';

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'cps-rename-'));
}

function writeState(dir, sid, stamp, body = '# state') {
  const name = `STATE_${sid}_${stamp}.md`;
  const p = path.join(dir, name);
  fs.writeFileSync(p, body, 'utf8');
  return p;
}

test('renameStateToNow: renames existing STATE file so embedded stamp is now', () => {
  const dir = tmpDir();
  const oldPath = writeState(dir, 'sid-aaaa', '20260101T000000Z', '# old');
  const now = new Date('2026-06-26T12:00:00Z');
  const newPath = renameStateToNow(oldPath, now);
  assert.notEqual(newPath, oldPath, 'must produce a different filename');
  assert.equal(path.dirname(newPath), dir);
  assert.equal(path.basename(newPath), 'STATE_sid-aaaa_20260626T120000Z.md');
  assert.equal(fs.existsSync(oldPath), false, 'old path is gone after rename');
  assert.equal(fs.readFileSync(newPath, 'utf8'), '# old', 'content survives rename');
});

test('renameStateToNow: slug is preserved across the rename', () => {
  const dir = tmpDir();
  const oldPath = writeState(dir, 'my-task_sid-x', '20260620T000000Z');
  const newPath = renameStateToNow(oldPath, new Date('2026-06-26T15:30:00Z'));
  assert.equal(path.basename(newPath), 'STATE_my-task_sid-x_20260626T153000Z.md');
});

test('renameStateToNow: sid is preserved across the rename', () => {
  const dir = tmpDir();
  const oldPath = writeState(dir, 'abc12345-1234-1234-1234-123456789012', '20260101T000000Z');
  const newPath = renameStateToNow(oldPath, new Date('2026-06-26T15:30:00Z'));
  const newBase = path.basename(newPath);
  assert.ok(newBase.startsWith('STATE_abc12345-1234-1234-1234-123456789012_'),
    `sid must be preserved, got: ${newBase}`);
  assert.ok(newBase.endsWith('_20260626T153000Z.md'), `stamp must advance, got: ${newBase}`);
});

test('renameStateToNow: bumps stamp by 1s when target name is already taken', () => {
  const dir = tmpDir();
  const oldPath = writeState(dir, 'sid-bbbb', '20260101T000000Z');
  // Pre-create the would-be target at the requested now-stamp
  const collision = writeState(dir, 'sid-bbbb', '20260626T120000Z');
  const newPath = renameStateToNow(oldPath, new Date('2026-06-26T12:00:00Z'));
  // The collision file must not be clobbered
  assert.equal(fs.existsSync(collision), true, 'parallel write must not be overwritten');
  assert.equal(fs.readFileSync(collision, 'utf8'), '# state', 'collision content intact');
  // The renamed file must live at the bumped stamp
  assert.equal(path.basename(newPath), 'STATE_sid-bbbb_20260626T120001Z.md');
  assert.equal(fs.existsSync(oldPath), false);
});

test('renameStateToNow: throws on missing source', () => {
  const dir = tmpDir();
  const ghost = path.join(dir, 'STATE_nope_20260101T000000Z.md');
  assert.throws(
    () => renameStateToNow(ghost, new Date('2026-06-26T12:00:00Z')),
    /source not found/,
  );
});

test('renameStateToNow: throws when source is not a STATE file', () => {
  const dir = tmpDir();
  const notState = path.join(dir, 'README.md');
  fs.writeFileSync(notState, 'noise', 'utf8');
  assert.throws(
    () => renameStateToNow(notState, new Date('2026-06-26T12:00:00Z')),
    /not a STATE file/,
  );
});

test('renameStateToNow: throws when no free stamp within 60s window', () => {
  const dir = tmpDir();
  const oldPath = writeState(dir, 'sid-cccc', '20260101T000000Z');
  // Saturate the next 60 seconds for this sid
  for (let i = 0; i <= 60; i++) {
    const d = new Date(Date.UTC(2026, 5, 26, 12, 0, i));
    const pad = (n) => String(n).padStart(2, '0');
    const stamp = d.getUTCFullYear()
      + pad(d.getUTCMonth() + 1) + pad(d.getUTCDate()) + 'T'
      + pad(d.getUTCHours()) + pad(d.getUTCMinutes()) + pad(d.getUTCSeconds()) + 'Z';
    writeState(dir, 'sid-cccc', stamp, 'saturation');
  }
  assert.throws(
    () => renameStateToNow(oldPath, new Date('2026-06-26T12:00:00Z')),
    /free stamp in 60s window/,
  );
  // Source must still exist on disk — the helper must not have moved it before failing
  assert.equal(fs.existsSync(oldPath), true);
});
