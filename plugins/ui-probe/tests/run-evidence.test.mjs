// Run evidence: a browser-backed run records the page's console and its traffic, and every
// listener it added is gone when the run ends — whichever way the run ends.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { run } from '../src/runner.mjs';
import { runTvBranch } from '../src/tv/cli.mjs';

const URL = 'http://127.0.0.1:1/page.html';

function stubCdp({ onNavigate = null, logEnable = true } = {}) {
  const calls = [];
  const handlers = new Map();
  const attached = new Map();
  let onCount = 0;
  let offCount = 0;

  const api = {
    calls,
    methods: () => calls.map((call) => call.method),
    onCount: () => onCount,
    offCount: () => offCount,
    attached: (method) => attached.get(method) ?? 0,
    listenerCount: () => [...handlers.values()].reduce((total, fns) => total + fns.length, 0),
    async fire(method, params) {
      for (const fn of [...(handlers.get(method) || [])]) await fn(params);
    },
    async send(method, params = {}) {
      calls.push({ method, params });
      if (method === 'Log.enable' && !logEnable) throw new Error('Log domain is not available');
      if (method === 'Page.navigate') {
        if (onNavigate) await onNavigate(api);
        await api.fire('Page.loadEventFired', {});
        return {};
      }
      if (method === 'Runtime.evaluate') {
        if (String(params.expression).includes('textContent')) {
          return { result: { value: { found: true, value: 'hello' } } };
        }
        return { result: { value: null } };
      }
      return {};
    },
    on(method, fn) {
      onCount += 1;
      attached.set(method, (attached.get(method) ?? 0) + 1);
      handlers.set(method, [...(handlers.get(method) || []), fn]);
      return () => {
        offCount += 1;
        handlers.set(method, (handlers.get(method) || []).filter((entry) => entry !== fn));
      };
    },
  };
  return api;
}

const passing = () => ({
  id: 'evidence',
  steps: [{ open: { url: URL } }, { expect_text: { target: 'h1', equals: 'hello' } }],
});

const failing = () => ({
  id: 'evidence',
  steps: [{ open: { url: URL } }, { expect_text: { target: 'h1', equals: 'never', timeoutMs: 0 } }],
});

test('row 5: a run enables recording before the guard, and returns what the page said and fetched', async () => {
  const cdp = stubCdp({
    onNavigate: async (api) => {
      await api.fire('Runtime.consoleAPICalled', { type: 'log', args: [{ value: 'hello console' }] });
      await api.fire('Log.entryAdded', { entry: { level: 'error', text: 'boom' } });
      await api.fire('Network.requestWillBeSent', {
        requestId: 'r1', request: { method: 'GET', url: 'http://127.0.0.1:1/api' },
      });
      await api.fire('Network.responseReceived', { requestId: 'r1', response: { status: 200 }, type: 'XHR' });
    },
  });
  const result = await run(passing(), { cdp, source: 'run.yaml' });

  assert.equal(result.outcome, 'passed', JSON.stringify(result.steps));
  const methods = cdp.methods();
  const guardAt = methods.indexOf('Fetch.enable');
  assert.ok(guardAt >= 0, `the guard was installed: ${methods.join(',')}`);
  for (const enable of ['Runtime.enable', 'Network.enable', 'Log.enable']) {
    const at = methods.indexOf(enable);
    assert.ok(at >= 0 && at < guardAt, `${enable} at ${at}, guard at ${guardAt}`);
  }
  assert.deepEqual(result.console, [
    { level: 'log', text: 'hello console' },
    { level: 'error', text: 'boom' },
  ]);
  assert.deepEqual(result.network, [{ method: 'GET', url: 'http://127.0.0.1:1/api', status: 200, blocked: false }]);
  assert.equal(cdp.listenerCount(), 0, 'every listener is removed');
});

test('row 5: a write the guard blocked is recorded as blocked', async () => {
  const cdp = stubCdp({
    onNavigate: async (api) => {
      await api.fire('Network.requestWillBeSent', {
        requestId: 'r2', request: { method: 'POST', url: 'http://127.0.0.1:1/save' },
      });
      await api.fire('Fetch.requestPaused', {
        requestId: 'r2', request: { method: 'POST', url: 'http://127.0.0.1:1/save' },
      });
    },
  });
  const result = await run(passing(), { cdp });

  assert.equal(result.outcome, 'passed', JSON.stringify(result.steps));
  assert.deepEqual(result.network, [{ method: 'POST', url: 'http://127.0.0.1:1/save', status: null, blocked: true }]);
  assert.ok(cdp.methods().includes('Fetch.failRequest'), 'the guard failed the write');
});

test('row 5: a failing run still records, and still removes every listener', async () => {
  const cdp = stubCdp({
    onNavigate: async (api) => {
      await api.fire('Runtime.consoleAPICalled', { type: 'error', args: [{ value: 'the app threw' }] });
    },
  });
  const result = await run(failing(), { cdp });

  assert.equal(result.outcome, 'failed');
  assert.deepEqual(result.console, [{ level: 'error', text: 'the app threw' }]);
  assert.equal(cdp.listenerCount(), 0, 'every listener is removed');
});

test('row 5: a guard install that throws still removes the recorder', async () => {
  const cdp = stubCdp();
  const send = cdp.send;
  cdp.send = async (method, params = {}) => {
    if (method === 'Fetch.enable') {
      cdp.calls.push({ method, params });
      throw new Error('Fetch.enable refused');
    }
    return send(method, params);
  };

  await assert.rejects(run(passing(), { cdp }), /Fetch\.enable refused/);
  assert.equal(cdp.listenerCount(), 0, 'the recorder and the half-installed guard are both gone');
});

test('row 6: a caller-owned recorder means run() enables nothing, attaches nothing, and returns no evidence', async () => {
  const cdp = stubCdp();
  let stops = 0;
  const evidence = { events: { requests: new Map(), console: [] }, stop: () => { stops += 1; } };
  const result = await run(passing(), { cdp, evidence });

  assert.equal(result.outcome, 'passed', JSON.stringify(result.steps));
  const methods = cdp.methods();
  for (const enable of ['Runtime.enable', 'Network.enable', 'Log.enable']) {
    assert.equal(methods.includes(enable), false, `${enable} was sent`);
  }
  for (const event of ['Network.requestWillBeSent', 'Network.responseReceived', 'Runtime.consoleAPICalled', 'Log.entryAdded']) {
    assert.equal(cdp.attached(event), 0, `run() attached a ${event} listener`);
  }
  assert.equal('console' in result, false);
  assert.equal('network' in result, false);
  assert.equal(stops, 0, 'run() does not stop a recorder it does not own');
});

test('row 7: a TV run returns the console and traffic fired on the attached target', async () => {
  const cdp = stubCdp({
    onNavigate: async (api) => {
      await api.fire('Runtime.consoleAPICalled', { type: 'warning', args: [{ value: 'tizen says hi' }] });
      await api.fire('Network.requestWillBeSent', {
        requestId: 'r3', request: { method: 'GET', url: 'http://192.0.2.30:8000/tv' },
      });
      await api.fire('Network.responseReceived', { requestId: 'r3', response: { status: 200 }, type: 'Document' });
    },
  });
  const doc = {
    id: 'tv-evidence',
    backend: 'tv',
    steps: [{ open: { url: URL } }, { expect_text: { target: 'h1', equals: 'hello' } }],
  };
  const done = await runTvBranch({
    doc,
    config: { baseUrl: URL, tv: { host: '192.0.2.10:26101', appid: 'torrenthub.main' } },
    rest: [],
    getFlag: () => null,
    _attach: async () => ({
      cdp,
      port: 9333,
      protocol: { domains: [{ domain: 'Fetch' }] },
      timings: { attachMs: 1, relaunchMs: null, settleMs: 2 },
      detach: async () => {},
    }),
  });

  assert.equal(done.exitCode, 0, JSON.stringify(done.result?.steps));
  assert.deepEqual(done.result.console, [{ level: 'warning', text: 'tizen says hi' }]);
  assert.deepEqual(done.result.network, [
    { method: 'GET', url: 'http://192.0.2.30:8000/tv', status: 200, blocked: false },
  ]);
});
