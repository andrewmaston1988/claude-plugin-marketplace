import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expandIncludes, parseScenario, validate, assertsNothing, OPS } from '../src/ir.mjs';
import { scenarios } from './fixtures/scenarios.mjs';

const fixture = (name) => scenarios[name];

function tempDir() {
  return mkdtempSync(join(tmpdir(), 'ui-probe-ir-'));
}

const yamlAt = (dir, name, text) => {
  const file = join(dir, name);
  writeFileSync(file, text);
  return file;
};

test('row 1: validation teaches the fix for missing expect_css property and unknown ops', () => {
  const result = validate({
    id: 'example',
    steps: [
      { expect_css: { target: '.tile', equals: 'visible' } },
      { expect_magic: { value: true } },
    ],
  });
  assert.ok(result.some((item) => item.field === 'steps[0].expect_css.property'
    && item.fix && item.example));
  assert.ok(result.some((item) => item.field === 'steps[1].expect_magic'
    && /unknown op/.test(item.problem) && item.fix && item.example));
  assert.ok(result.every((item) => ['field', 'problem', 'fix', 'example'].every((key) => key in item)));
});

test('row 2: YAML examples compile after removing bake-off task metadata', () => {
  for (const name of ['t1-layout', 't2-hover', 'http-health']) {
    const doc = parseScenario(fixture(name), { format: 'yaml' });
    assert.equal(doc.id, name);
    assert.deepEqual(validate(doc), []);
  }
  const withTask = parseScenario(`id: example\ntask: example\nsteps:\n  - expect_json: { url: "https://example.test", path: ok, equals: true }\n`, { format: 'yaml' });
  assert.ok(validate(withTask).some((item) => item.field === 'task'));
});

test('row 2: document shape and deferred operations are named', () => {
  assert.ok(validate({ steps: [] }).some((item) => item.field === 'id'));
  assert.ok(validate({ id: 'valid-id', steps: [] }).some((item) => item.field === 'steps'));
  const deferred = [];
  for (const op of ['tcp_banner', 'uia_text']) {
    const problems = validate({ id: 'valid-id', steps: [{ [op]: {} }] });
    deferred.push(...problems);
    assert.ok(problems.some((item) => item.field.includes(op) && /not supported in this version/i.test(item.problem)));
  }
  const role = validate({ id: 'valid-id', steps: [{ click: { target: 'role=button[name="Save"]' } }] });
  assert.ok(role.some((item) => item.field === 'steps[0].click.target' && /not in this version/i.test(item.problem)));
  const all = [...deferred, ...role, ...validate({ id: 'valid-id', steps: [{ expect_magic: {} }] })];
  assert.equal(all.some((item) => `${item.problem} ${item.fix} ${item.example}`.includes('ui-probe-')), false, JSON.stringify(all));
});

test('row 24: a viewport step carries an optional dpr and rejects a non-positive one', () => {
  assert.ok(OPS.viewport.optional.includes('dpr'));
  assert.deepEqual(validate({ id: 'valid-id', steps: [{ viewport: { width: 390, height: 844, dpr: 3 } }] }), []);
  for (const dpr of [0, -1, 'x']) {
    const problems = validate({ id: 'valid-id', steps: [{ viewport: { width: 390, height: 844, dpr } }] });
    assert.ok(problems.some((item) => item.field === 'steps[0].viewport.dpr' && item.problem && item.fix && item.example), String(dpr));
  }
});

test('row 8: validate accepts table keys and rejects Exit and unknown names', () => {
  assert.deepEqual(validate({
    id: 'tv-keys',
    backend: 'tv',
    steps: [{ key: { key: 'Left' } }, { key: { key: 'MediaPlay', repeat: 3, gapMs: 50, autoRepeat: true } }],
  }), []);
  for (const name of ['Exit', 'VolumeUp']) {
    const problems = validate({ id: 'tv-keys', backend: 'tv', steps: [{ key: { key: name } }] });
    const hit = problems.find((item) => item.field === 'steps[0].key.key');
    assert.ok(hit && hit.problem.includes(name) && hit.fix && hit.example, `${name}: ${JSON.stringify(problems)}`);
  }
  const badRepeat = validate({ id: 'tv-keys', backend: 'tv', steps: [{ key: { key: 'Left', repeat: 0 } }] });
  assert.ok(badRepeat.some((item) => item.field === 'steps[0].key.repeat'));
  const badAuto = validate({ id: 'tv-keys', backend: 'tv', steps: [{ key: { key: 'Left', autoRepeat: 'yes' } }] });
  assert.ok(badAuto.some((item) => item.field === 'steps[0].key.autoRepeat'));
});

test('row 9: a tv backend is valid and rejects the pointer ops naming why', () => {
  assert.deepEqual(validate({ id: 'tv-journey', backend: 'tv', steps: [{ key: { key: 'Down' } }] }), []);
  for (const op of ['hover', 'tap', 'click']) {
    const problems = validate({ id: 'tv-journey', backend: 'tv', steps: [{ [op]: { target: '.tile' } }] });
    const hit = problems.find((item) => item.field === `steps[0].${op}`);
    assert.ok(hit && /remote|pointer/i.test(hit.problem), `${op}: ${JSON.stringify(problems)}`);
    assert.ok(hit.fix && hit.example, `${op} teaches no fix`);
  }
  assert.deepEqual(validate({ id: 'browser-case', steps: [{ click: { target: '.tile' } }] }), []);
  assert.ok(validate({ id: 'bad-backend', backend: 'watch', steps: [] }).some((item) => item.field === 'backend'));
});

test('row 13: include splices the named file steps in order', () => {
  const dir = tempDir();
  try {
    yamlAt(dir, 'prefix.yaml', 'steps:\n  - open: { url: "/home" }\n  - expect_visible: { target: "#greeting" }\n');
    const root = yamlAt(dir, 'root.yaml', [
      'id: root', 'steps:', '  - viewport: { width: 1920, height: 1080 }',
      '  - include: prefix.yaml', '  - expect_text: { target: "h1", equals: "Hi" }', '',
    ].join('\n'));
    const doc = parseScenario(readFileSync(root, 'utf8'), { format: 'yaml' });
    const { doc: expanded, problems } = expandIncludes(doc, { baseDir: dir, file: root });
    assert.deepEqual(problems, []);
    assert.deepEqual(expanded.steps.map((step) => Object.keys(step)[0]), ['viewport', 'open', 'expect_visible', 'expect_text']);
    assert.deepEqual(validate(doc, { baseDir: dir, file: root }), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('row 13: a missing include, a second-level include and a cycle are validate errors naming the file', () => {
  const dir = tempDir();
  try {
    const root = join(dir, 'root.yaml');
    const check = () => validate(parseScenario(readFileSync(root, 'utf8'), { format: 'yaml' }), { baseDir: dir, file: root });

    yamlAt(dir, 'root.yaml', 'id: root\nsteps:\n  - include: missing.yaml\n  - expect_visible: { target: "body" }\n');
    const missing = check();
    assert.ok(missing.some((item) => item.problem.includes('missing.yaml')), JSON.stringify(missing));

    yamlAt(dir, 'a.yaml', 'steps:\n  - include: b.yaml\n');
    yamlAt(dir, 'b.yaml', 'steps:\n  - expect_visible: { target: "body" }\n');
    yamlAt(dir, 'root.yaml', 'id: root\nsteps:\n  - include: a.yaml\n  - expect_visible: { target: "body" }\n');
    const nested = check();
    assert.ok(nested.some((item) => /second-level/i.test(item.problem) && item.problem.includes('b.yaml')), JSON.stringify(nested));

    yamlAt(dir, 'a.yaml', 'steps:\n  - include: root.yaml\n');
    yamlAt(dir, 'root.yaml', 'id: root\nsteps:\n  - include: a.yaml\n  - expect_visible: { target: "body" }\n');
    const cycle = check();
    assert.ok(cycle.some((item) => /cycle/i.test(item.problem)
      && item.problem.includes('root.yaml') && item.problem.includes('a.yaml')), JSON.stringify(cycle));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('JSON parsing and assertion detection share the scenario IR', () => {
  const doc = parseScenario(JSON.stringify({ id: 'json-case', steps: [{ open: { url: '/home' } }] }), { format: 'json' });
  assert.deepEqual(validate(doc), []);
  assert.deepEqual(assertsNothing(doc), ['no assertion step: a scenario that asserts nothing is not a scenario']);
  assert.deepEqual(assertsNothing({ steps: [{ expect_hidden: { target: '.missing' } }] }), []);
  assert.ok(OPS.expect_css.optional.includes('over'));
  assert.ok(OPS.expect_widths.optional.includes('timeoutMs'));
});
