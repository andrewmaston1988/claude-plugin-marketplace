// The guided listen registers the key it is about to ask for. Only the arrows, Enter and Back
// reach a Tizen page unregistered, so a digit or media key nobody registered cannot arrive.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tvProbe } from '../src/tv/probe.mjs';
import {
  cleanupReply, currentReply, featuresReply, installReply, labelKey, listenStub, noSleep, PAGE,
  pageReply, readReply, registerReply, unregisterReply,
} from './tv-support.mjs';

// The feature read registers '1' too; its reply is consumed first, so it is not sticky.
const repliesFor = (...extra) => [
  pageReply(PAGE), featuresReply(), registerReply('returned'), currentReply('object'),
  installReply, readReply([]), cleanupReply, ...extra,
];

const returnedEveryTime = () => repliesFor(
  registerReply('returned', { sticky: true }),
  unregisterReply('returned', { sticky: true }),
);

const expressionsOf = (cdp) => cdp.sent('Runtime.evaluate').map((call) => String(call.params.expression));

// Only the listen's own calls: the feature read and the key step register '1' before it starts.
function listenTrace(cdp) {
  const expressions = expressionsOf(cdp);
  const start = expressions.reduce((at, js, index) => (js.includes('__uiProbeKey = {') ? index : at), -1);
  const trace = [];
  for (const js of expressions.slice(start + 1)) {
    const prompt = /Press (.+?) on the remote/.exec(js);
    if (prompt) { trace.push(`prompt:${labelKey(prompt[1])}`); continue; }
    const unregister = /\.unregisterKey\("([^"]*)"\)/.exec(js);
    if (unregister) { trace.push(`unregister:${unregister[1]}`); continue; }
    const register = /\bdevice\.registerKey\("([^"]*)"\)/.exec(js);
    if (register) trace.push(`register:${register[1]}`);
  }
  return trace;
}

// The result write, not the prompt: both set `box.textContent`, only the prompt sets the mark.
const banners = (cdp) => expressionsOf(cdp).filter((js) => js.includes('box.textContent = ') && !js.includes('state.mark'));

test('row 1: --listen registers each non-mandatory key around its own prompt', async () => {
  const stub = listenStub({ replies: returnedEveryTime() });
  const platform = await tvProbe(stub.cdp, {
    listenKeys: 'Left,Digit5,MediaPlay,Back',
    listenWaitSeconds: 1,
    _sleep: noSleep,
  });

  assert.equal(platform.listen.status, 'measured');
  assert.deepEqual(listenTrace(stub.cdp), [
    'prompt:Left',
    'register:5', 'prompt:Digit5', 'unregister:5',
    'register:MediaPlay', 'prompt:MediaPlay', 'unregister:MediaPlay',
    'prompt:Back',
  ]);

  const byKey = Object.fromEntries(platform.listen.results.map((entry) => [entry.key, entry]));
  assert.deepEqual(
    platform.listen.keys.map((name) => [name, byKey[name].register]),
    [['Left', 'not-needed'], ['Digit5', 'returned'], ['MediaPlay', 'returned'], ['Back', 'not-needed']],
    'mandatory keys register nothing',
  );
  assert.equal(byKey.Digit5.unregister, 'returned');
  assert.equal(byKey.MediaPlay.unregister, 'returned');
});

test('row 2: a returned register is unregistered, any other answer is absent and sends none', async () => {
  const returned = listenStub({ replies: returnedEveryTime() });
  const returnedPlatform = await tvProbe(returned.cdp, {
    listenKeys: 'Digit5', listenWaitSeconds: 1, _sleep: noSleep,
  });
  assert.equal(returnedPlatform.listen.results[0].register, 'returned');
  assert.equal(returnedPlatform.listen.results[0].unregister, 'returned');
  assert.deepEqual(listenTrace(returned.cdp), ['register:5', 'prompt:Digit5', 'unregister:5']);

  // Every existing stub answers an unmatched evaluate with null: that is not a return.
  const unanswered = listenStub({ replies: repliesFor() });
  const unansweredPlatform = await tvProbe(unanswered.cdp, {
    listenKeys: 'Digit5', listenWaitSeconds: 1, _sleep: noSleep,
  });
  assert.equal(unansweredPlatform.listen.results[0].register, 'absent');
  assert.equal('unregister' in unansweredPlatform.listen.results[0], false, 'nothing was registered');
  assert.deepEqual(listenTrace(unanswered.cdp), ['register:5', 'prompt:Digit5']);

  const absent = listenStub({ replies: repliesFor(registerReply('absent', { sticky: true })) });
  const absentPlatform = await tvProbe(absent.cdp, {
    listenKeys: 'Digit5', listenWaitSeconds: 1, _sleep: noSleep,
  });
  assert.equal(absentPlatform.listen.results[0].register, 'absent');
  assert.equal('unregister' in absentPlatform.listen.results[0], false);
  assert.deepEqual(listenTrace(absent.cdp), ['register:5', 'prompt:Digit5']);
});

test('row 2: a register that throws records the error and sends no unregister', async () => {
  const stub = listenStub({
    replies: [
      pageReply(PAGE), featuresReply(), registerReply('returned'), currentReply('object'),
      installReply, readReply([]), cleanupReply,
      { match: (e) => e.includes('registerKey(') && !e.includes('unregisterKey('), error: new Error('NotSupportedError'), sticky: true },
    ],
  });
  const platform = await tvProbe(stub.cdp, {
    listenKeys: 'Digit5', listenWaitSeconds: 1, _sleep: noSleep,
  });

  assert.equal(platform.listen.results[0].register, 'threw');
  assert.match(platform.listen.results[0].registerError, /NotSupportedError/);
  assert.equal('unregister' in platform.listen.results[0], false);
  assert.deepEqual(listenTrace(stub.cdp), ['register:5', 'prompt:Digit5']);
});

test('row 2: a poll that throws mid-key still unregisters the key it registered', async () => {
  const stub = listenStub({ replies: returnedEveryTime(), failKey: 'Digit5' });
  const platform = await tvProbe(stub.cdp, {
    listenKeys: 'Digit5,MediaPlay', listenWaitSeconds: 1, _sleep: noSleep,
  });

  assert.equal(platform.listen.status, 'error');
  assert.match(platform.listen.error, /evaluate failed/);
  assert.deepEqual(listenTrace(stub.cdp), ['register:5', 'prompt:Digit5', 'unregister:5']);
});

test('row 3: a miss names a failed register on the banner, a returned one prints bare', async () => {
  const absent = listenStub({ replies: repliesFor() });
  await tvProbe(absent.cdp, { listenKeys: 'Digit1', listenWaitSeconds: 1, _sleep: noSleep });
  const absentBanner = banners(absent.cdp).find((js) => js.includes('not received'));
  assert.match(absentBanner, /✗ 1 — not received \(registerKey absent\)/);

  const returned = listenStub({ replies: returnedEveryTime() });
  await tvProbe(returned.cdp, { listenKeys: 'Digit1', listenWaitSeconds: 1, _sleep: noSleep });
  const returnedBanner = banners(returned.cdp).find((js) => js.includes('not received'));
  assert.match(returnedBanner, /✗ 1 — not received"/, 'a returned register explains nothing');
  assert.doesNotMatch(returnedBanner, /registerKey/);
});
