// Step labels: a step names the file it is written in and the line of its `-`. A step with no
// known line — JSON, or built in code — names its position within its own file instead.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { parseScenario } from '../src/ir.mjs';
import { run } from '../src/runner.mjs';

const URL = 'http://127.0.0.1:1/page.html';

function stubCdp() {
  const handlers = new Map();
  return {
    async send(method, params = {}) {
      if (method === 'Page.navigate') {
        for (const fn of handlers.get('Page.loadEventFired') || []) fn({});
        return {};
      }
      if (method === 'Runtime.evaluate') {
        const expression = String(params.expression);
        if (expression.includes('textContent')) return { result: { value: { found: true, value: 'hello' } } };
        return { result: { value: null } };
      }
      return {};
    },
    on(method, fn) {
      handlers.set(method, [...(handlers.get(method) || []), fn]);
      return () => handlers.set(method, (handlers.get(method) || []).filter((entry) => entry !== fn));
    },
  };
}

async function labelsOf(text, { format = 'yaml', source, baseDir = null, file = null } = {}) {
  const doc = parseScenario(text, { format });
  const result = await run(doc, { cdp: stubCdp(), source, baseDir, file });
  assert.equal(result.outcome, 'passed', JSON.stringify(result.steps));
  return result.steps.map((step) => step.source);
}

test('row 1: a YAML step labels the line of its "-", past comments and blank lines', async () => {
  const text = [
    '# step label fixture',                        // 1
    'id: labels',                                   // 2
    'backend: browser',                             // 3
    'steps:',                                       // 4
    `  - open: { url: "${URL}" }`,                  // 5
    '',                                             // 6
    '  - expect_text:',                             // 7
    '      target: "h1"',                           // 8
    '      equals: "hello"',                        // 9
    '',
  ].join('\n');
  assert.deepEqual(await labelsOf(text, { source: 'labels.yaml' }), ['labels.yaml:5', 'labels.yaml:7']);
});

test('row 1: a bare "-" labels its own line, and a flow-map step labels its own line', async () => {
  const text = [
    'id: shapes',                                   // 1
    'steps:',                                       // 2
    `  - { open: { url: "${URL}" } }`,              // 3
    '  -',                                          // 4
    '    expect_text:',                             // 5
    '      target: "h1"',                           // 6
    '      equals: "hello"',                        // 7
    '',
  ].join('\n');
  assert.deepEqual(await labelsOf(text, { source: 'shapes.yaml' }), ['shapes.yaml:3', 'shapes.yaml:4']);
});

test('row 2: an included step labels the include as written and its line in that file', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ui-probe-labels-'));
  try {
    writeFileSync(join(dir, 'prefix.yaml'), [
      'id: prefix',                                 // 1
      'steps:',                                     // 2
      '  - expect_text: { target: "h1", equals: "hello" }', // 3
      '  - expect_text: { target: "h1", equals: "hello" }', // 4
      '',
    ].join('\n'));
    const journey = [
      'id: journey',                                // 1
      'backend: browser',                           // 2
      'steps:',                                     // 3
      `  - open: { url: "${URL}" }`,                // 4
      '  - include: prefix.yaml',                   // 5
      '  - expect_text: { target: "h1", equals: "hello" }', // 6
      '',
    ].join('\n');
    const file = join(dir, 'journey.yaml');
    writeFileSync(file, journey);
    assert.deepEqual(
      await labelsOf(journey, { source: 'journey.yaml', baseDir: dir, file }),
      ['journey.yaml:4', 'prefix.yaml:3', 'prefix.yaml:4', 'journey.yaml:6'],
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('row 3: a step with no known line labels its own position within its own file', async () => {
  const json = JSON.stringify({
    id: 'json-labels',
    steps: [{ open: { url: URL } }, { expect_text: { target: 'h1', equals: 'hello' } }],
  });
  assert.deepEqual(await labelsOf(json, { format: 'json', source: 'labels.json' }), [
    'labels.json#step1',
    'labels.json#step2',
  ]);
});

test('row 3: a JSON include labels its own name and its position, never the parent', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ui-probe-labels-json-'));
  try {
    writeFileSync(join(dir, 'prefix.json'), JSON.stringify({
      id: 'prefix',
      steps: [{ expect_text: { target: 'h1', equals: 'hello' } }, { expect_text: { target: 'h1', equals: 'hello' } }],
    }));
    const journey = [
      'id: journey',                                // 1
      'backend: browser',                           // 2
      'steps:',                                     // 3
      `  - open: { url: "${URL}" }`,                // 4
      '  - include: prefix.json',                   // 5
      '  - expect_text: { target: "h1", equals: "hello" }', // 6
      '',
    ].join('\n');
    const file = join(dir, 'journey.yaml');
    writeFileSync(file, journey);
    assert.deepEqual(
      await labelsOf(journey, { source: 'journey.yaml', baseDir: dir, file }),
      ['journey.yaml:4', 'prefix.json#step1', 'prefix.json#step2', 'journey.yaml:6'],
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('row 3: a capture screen built from JSON config labels the screen and the step position', async () => {
  // The screen's steps live in the config file, so there is no line and no include to name.
  const doc = { id: 'capture', steps: [{ expect_text: { target: 'h1', equals: 'hello' } }] };
  const result = await run(doc, { cdp: stubCdp(), source: 'broken', requireAssertion: false });
  assert.equal(result.steps[0].source, 'broken#step1');
});
