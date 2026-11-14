// Every expression the probe sends into the page must parse on the set's Chromium 69. Nullish
// coalescing and optional chaining arrived in Chromium 80, logical assignment in 85: a script
// using them throws a SyntaxError on the set, and the step reports nothing it actually measured.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { run } from '../src/runner.mjs';
import { tvProbe } from '../src/tv/probe.mjs';
import {
  cleanupReply, currentReply, featuresReply, installReply, listenStub, noSleep, PAGE,
  pageReply, readReply, registerReply, stubCdp,
} from './tv-support.mjs';

const M69_UNPARSEABLE = /\?\?|\|\|=|&&=|\?\.(?!\d)/;

function expressionsSent(cdp) {
  return cdp.sent('Runtime.evaluate').map((call) => String(call.params.expression));
}

function assertParsesOnM69(expressions) {
  for (const expression of expressions) {
    const found = M69_UNPARSEABLE.exec(expression);
    if (found) {
      assert.fail(`Chromium 69 cannot parse ${JSON.stringify(found[0])}, so this page expression `
        + `throws a SyntaxError instead of measuring:\n${expression}`);
    }
  }
}

// Every reader the sampler can build, over both judging modes. A passing step proves the
// expression was actually sent; the assertion below then reads what was sent.
const OVER_SCENARIO = {
  id: 'page-syntax',
  backend: 'tv',
  steps: [
    { expect_css: { target: '#tile', property: 'display', equals: 'flex', over: 120, mode: 'any' } },
    { expect_css: { target: '#tile', property: 'display', equals: 'flex', over: 120, mode: 'all' } },
    { expect_text: { target: '#tile', equals: 'hello', over: 120, mode: 'any' } },
    { expect_text: { target: '#tile', equals: 'hello', over: 120, mode: 'all' } },
    { expect_prop: { target: '#tile', property: 'value', equals: 'ok', over: 120, mode: 'any' } },
    { expect_prop: { target: '#tile', property: 'value', equals: 'ok', over: 120, mode: 'all' } },
    { expect_count: { target: '.tile', equals: 3, over: 120, mode: 'any' } },
    { expect_count: { target: '.tile', gt: 1, over: 120, mode: 'all' } },
  ],
};

const samplerReply = {
  match: (expression) => expression.includes('requestAnimationFrame'),
  sticky: true,
  value: { matches: 1, frames: 3, first: { index: 0, ms: 1, value: 'ok' }, firstMiss: null },
};

const guard = { blocked: [], uninstall: async () => {} };

test('every over sampler expression sent by a tv run parses on Chromium 69', async () => {
  const cdp = stubCdp({ replies: [samplerReply] });
  const result = await run(OVER_SCENARIO, { cdp, device: 'tv', guard });

  assert.deepEqual(result.steps.map((step) => step.outcome), OVER_SCENARIO.steps.map(() => 'passed'));
  assert.equal(expressionsSent(cdp).length, OVER_SCENARIO.steps.length);
  assertParsesOnM69(expressionsSent(cdp));
});

// The probe's own page scripts, including the navigate poll and the guided listen's prompt and
// read loop, run on the same engine.
test('every tv probe page script parses on Chromium 69', async () => {
  const navigateReply = {
    match: (expression) => expression.includes('document.readyState'),
    value: { href: `${PAGE.origin}/after`, origin: PAGE.origin, title: 'after', ready: 'complete' },
  };
  const { cdp, prompts } = listenStub({
    replies: [
      pageReply(PAGE), featuresReply(), registerReply('returned'), currentReply('object'),
      installReply, readReply([]), navigateReply, cleanupReply,
    ],
    batches: { Left: [[{ type: 'keydown', key: 'ArrowLeft', code: 'ArrowLeft', keyCode: 37 }]] },
  });

  const platform = await tvProbe(cdp, {
    navigate: `${PAGE.origin}/after`,
    listenKeys: 'Left',
    listenWaitSeconds: 1,
    testOrigin: PAGE.origin,
    _sleep: noSleep,
  });

  assert.equal(platform.listen.status, 'measured');
  assert.deepEqual(prompts, ['Left']);
  assertParsesOnM69(expressionsSent(cdp));
});
