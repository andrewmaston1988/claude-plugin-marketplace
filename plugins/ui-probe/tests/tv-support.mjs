// In-process CDP stub shared by the TV tests: replies are matched against the evaluated
// expression in order, so a test states what the page answers rather than mocking a method.

// The set's 39-domain protocol: Network interception exists, Fetch does not.
export const TV_PROTOCOL = {
  domains: [
    { domain: 'Input', commands: [{ name: 'dispatchKeyEvent' }] },
    { domain: 'Network', commands: [{ name: 'enable' }, { name: 'setRequestInterception' }, { name: 'continueInterceptedRequest' }] },
  ],
};

export const noSleep = async () => {};

export function stubCdp({ replies = [], onSend = null } = {}) {
  const calls = [];
  const handlers = new Map();
  const queue = replies.map((reply) => ({ ...reply, used: false }));
  const api = {
    calls,
    methods: () => calls.map((call) => call.method),
    sent: (method) => calls.filter((call) => call.method === method),
    on(method, fn) {
      handlers.set(method, [...(handlers.get(method) || []), fn]);
      return () => handlers.set(method, (handlers.get(method) || []).filter((f) => f !== fn));
    },
    async fire(method, params) {
      for (const fn of handlers.get(method) || []) await fn(params);
    },
    async send(method, params = {}) {
      calls.push({ method, params });
      if (onSend) {
        const custom = onSend(method, params, api);
        if (custom !== undefined) return custom;
      }
      if (method === 'Runtime.evaluate') {
        const reply = queue.find((entry) => !entry.used && entry.match(params.expression));
        if (!reply) return { result: { value: null } };
        if (!reply.sticky) reply.used = true;
        if (reply.error) throw reply.error;
        return { result: { value: reply.value } };
      }
      return {};
    },
  };
  return api;
}
