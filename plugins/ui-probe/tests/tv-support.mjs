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

// The reply kit for a stub TV page: what the probe's page scripts answer, in the order it asks.
export const PAGE = { href: 'http://192.0.2.30:8000/tv?tizen=1', origin: 'http://192.0.2.30:8000' };
// The probe's page read. `navigateStep`'s location read also names the origin, so it is excluded
// here: the two ask different questions and must not answer each other.
export const pageReply = (value = PAGE) => ({
  match: (e) => e.includes('location.origin') && !e.includes('document.title'),
  value,
  sticky: true,
});

const featuresValue = (overrides = {}) => ({
  userAgent: 'Mozilla/5.0 (SMART-TV)',
  tizen: 'object',
  tvinputdevice: 'object',
  application: 'object',
  webapis: 'object',
  IntersectionObserver: true,
  ResizeObserver: false,
  flexGap: false,
  aspectRatio: false,
  backdropFilter: false,
  registerKeyPresent: true,
  currentAppPresent: true,
  ...overrides,
});

export const featuresReply = (overrides) => ({ match: (e) => e.includes('IntersectionObserver'), value: featuresValue(overrides) });
// `unregisterKey(` contains `registerKey(`: a plain substring match answers both calls.
export const registerReply = (value, { sticky = false } = {}) => ({
  match: (e) => e.includes('registerKey(') && !e.includes('unregisterKey('),
  value,
  ...(sticky ? { sticky: true } : {}),
});
export const unregisterReply = (value, { sticky = false } = {}) => ({
  match: (e) => e.includes('unregisterKey('),
  value,
  ...(sticky ? { sticky: true } : {}),
});
export const currentReply = (value) => ({ match: (e) => e.includes('getCurrentApplication'), value });
export const installReply = { match: (e) => e.includes('__uiProbeKey ='), value: { active: 'BODY' } };
export const readReply = (value) => ({ match: (e) => e.includes('__uiProbeKey.read()'), value });
export const cleanupReply = { match: (e) => e.includes('removeEventListener'), value: true };

export const plainRun = (overrides = {}) => [
  pageReply(PAGE),
  featuresReply(),
  registerReply('returned'),
  currentReply('object'),
  installReply,
  readReply([{ type: 'keydown', key: 'ArrowLeft', code: 'ArrowLeft', keyCode: 37 }]),
  cleanupReply,
  ...(overrides.extra ?? []),
];

export const keyCodes = (cdp) => cdp.sent('Input.dispatchKeyEvent').map((call) => call.params.windowsVirtualKeyCode);

// The label the operator reads on the set, back to the key table's name.
const LABEL_KEYS = Object.freeze({
  Left: 'Left', Right: 'Right', Up: 'Up', Down: 'Down', OK: 'Enter', Back: 'Back', Play: 'MediaPlay',
});

export function labelKey(label) {
  if (/^[0-9]$/.test(label)) return `Digit${label}`;
  return LABEL_KEYS[label] ?? label;
}

/**
 * A stub for the guided listen. Prompts and per-key reads are answered from `batches`, so a test
 * states which press arrives for which key and in what order; everything else falls to `replies`.
 */
export function listenStub({ replies = [], batches = {}, failKey = null } = {}) {
  let current = null;
  const prompts = [];
  const order = [];
  const cdp = stubCdp({
    replies,
    onSend: (method, params) => {
      if (method !== 'Runtime.evaluate') return undefined;
      const js = String(params.expression);
      const prompt = /Press (.+?) on the remote/.exec(js);
      if (prompt) {
        current = labelKey(prompt[1]);
        prompts.push(prompt[1]);
        order.push(`prompt:${current}`);
        return { result: { value: true } };
      }
      if (js.includes('state.log.slice')) {
        if (failKey === current) throw new Error('evaluate failed');
        const waiting = batches[current] ?? [];
        return { result: { value: { events: waiting.length ? waiting.shift() : [] } } };
      }
      return undefined;
    },
  });
  return { cdp, prompts, order };
}

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
