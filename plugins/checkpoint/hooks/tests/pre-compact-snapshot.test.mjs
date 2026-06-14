import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildSkeleton } from '../pre-compact-snapshot.mjs';

test('skeleton carries the marker the checkpoint skill detects', () => {
  const body = buildSkeleton([], 'auto', 'sid123456789', '/tmp/proj', 1234);
  assert.match(body, /Skeletal backstop written by `pre-compact-snapshot\.mjs`/);
  assert.match(body, /## Session/);
});

test('skeleton extracts last user/assistant text', () => {
  const entries = [
    { message: { role: 'user', content: 'do the thing' } },
    { message: { role: 'assistant', content: [{ type: 'text', text: 'done the thing' }] } },
  ];
  const body = buildSkeleton(entries, 'manual', 'sid', '/tmp', 10);
  assert.match(body, /do the thing/);
  assert.match(body, /done the thing/);
});
