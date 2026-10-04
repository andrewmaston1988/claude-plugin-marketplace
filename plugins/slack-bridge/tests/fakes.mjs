// Shared fakes for handler-level tests.
export function delay(ms) { return new Promise(r => setTimeout(r, ms)); }

export function makeLog() {
  const entries = [];
  const log = {
    info: (...a) => entries.push(["info", ...a]),
    warn: (...a) => entries.push(["warn", ...a]),
    error: (...a) => entries.push(["error", ...a]),
    child: () => log,
    entries,
  };
  return log;
}

export function makeStore(initial = {}) {
  const data = { ...initial };
  return {
    get: k => data[k],
    set: (k, v) => { data[k] = v; },
    delete: k => { delete data[k]; },
    all: () => ({ ...data }),
    _data: data,
  };
}

export function makeWeb({ postTs = "ts1", updateError } = {}) {
  const calls = [];
  const web = {
    calls,
    chatPostMessage: async p => { calls.push(["post", p]); return { ts: postTs, ok: true }; },
    chatUpdate: async p => {
      calls.push(["update", p]);
      if (updateError) throw updateError;
      return {};
    },
    chatDelete: async p => { calls.push(["delete", p]); return {}; },
    authTest: async () => ({ user_id: "U123", team_id: "T1" }),
  };
  return web;
}

export function makeSocket() {
  const handlers = {};
  return {
    on(evt, fn) { handlers[evt] = fn; return this; },
    start() {},
    _handlers: handlers,
  };
}
