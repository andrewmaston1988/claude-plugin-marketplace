import test from 'node:test';
import assert from 'node:assert/strict';
import { parseScenario, validate, assertsNothing, OPS } from '../src/ir.mjs';
import { scenarios } from './fixtures/scenarios.mjs';

const fixture = (name) => scenarios[name];

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

test('JSON parsing and assertion detection share the scenario IR', () => {
  const doc = parseScenario(JSON.stringify({ id: 'json-case', steps: [{ open: { url: '/home' } }] }), { format: 'json' });
  assert.deepEqual(validate(doc), []);
  assert.deepEqual(assertsNothing(doc), ['no assertion step: a scenario that asserts nothing is not a scenario']);
  assert.deepEqual(assertsNothing({ steps: [{ expect_hidden: { target: '.missing' } }] }), []);
  assert.ok(OPS.expect_css.optional.includes('over'));
  assert.ok(OPS.expect_widths.optional.includes('timeoutMs'));
});
