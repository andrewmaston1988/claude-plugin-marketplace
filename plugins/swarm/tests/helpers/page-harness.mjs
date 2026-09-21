// The vm harness page.html's tests drive: a mini-DOM, a global fetch the test
// resolves by hand, and the fixtures every page test starts from. Split out of
// page-route.test.mjs when the file went over the 500-line bar — the tests and
// the machinery that boots the page are separate concerns.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

// page.html is one IIFE inside a <script> tag with no exports: route(), the
// renderers, the paint primitives and `api` are all closed over. So this
// harness does not stub `api()` (it is unreachable from outside) — it stubs
// the GLOBAL fetch that api() calls, captures the listeners the page registers
// (hashchange/resize on window, run/runs on the EventSource), and runs a
// mini-DOM underneath setHtml/morph so a test observes the same tree a phone
// would. Every fetch resolves by hand, because the defect is a race: only a
// harness that controls resolution order can reproduce it.

export const PAGE = fileURLToPath(new URL("../../src/serve/page.html", import.meta.url));
const LIVE_JS = readFileSync(fileURLToPath(new URL("../../src/serve/live.js", import.meta.url)), "utf8");

// ── mini-DOM ─────────────────────────────────────────────────────────────
// Just enough of a DOM for page.html to boot and paint for real: setHtml
// parses markup into a node tree and morph() walks it. Supports exactly the
// tags and attributes page.html's templates produce — not a general engine.

function makeText(v) {
  const t = { nodeType: 3, nodeValue: String(v), get textContent() { return this.nodeValue; } };
  t.cloneNode = () => makeText(t.nodeValue);
  return t;
}

function makeElement(tag, ids) {
  const el = {
    nodeType: 1, tagName: tag.toUpperCase(), attributes: [], childNodes: [], parentNode: null, listeners: {},
    style: { setProperty() {} }, dataset: {},
  };
  Object.defineProperty(el, "parentElement", { get: () => el.parentNode });
  Object.defineProperty(el, "children", { get: () => el.childNodes.filter((n) => n.nodeType === 1) });
  Object.defineProperty(el, "textContent", {
    get: () => el.childNodes.map((n) => n.textContent).join(""),
    set: (v) => { el.childNodes = [makeText(v)]; },
  });
  el.hasAttribute = (n) => el.attributes.some((a) => a.name === n);
  el.getAttribute = (n) => { const a = el.attributes.find((x) => x.name === n); return a ? a.value : ""; };
  el.setAttribute = (n, v) => {
    const a = el.attributes.find((x) => x.name === n);
    if (a) a.value = String(v); else el.attributes.push({ name: n, value: String(v) });
    if (n === "id") ids.set(String(v), el);
  };
  el.removeAttribute = (n) => { el.attributes = el.attributes.filter((a) => a.name !== n); };
  Object.defineProperty(el, "className", { get: () => el.getAttribute("class"), set: (v) => el.setAttribute("class", v) });
  const read = () => new Set(el.getAttribute("class").split(/\s+/).filter(Boolean));
  const write = (cs) => el.setAttribute("class", [...new Set(cs)].join(" "));
  el.classList = {
    add: (...cs) => write([...read(), ...cs]),
    remove: (...cs) => write([...read()].filter((c) => !cs.includes(c))),
    toggle: (n, force) => { const want = force === undefined ? !read().has(n) : force; write([...read()].filter((c) => c !== n)); if (want) write([...read(), n]); return want; },
    contains: (n) => read().has(n),
  };
  el.getBoundingClientRect = () => ({ top: 0, left: 0, width: 0, height: 0 });
  el.addEventListener = (t, f) => { (el.listeners[t] ||= []).push(f); };
  el.appendChild = (c) => { c.parentNode = el; el.childNodes.push(c); return c; };
  el.insertBefore = (n, ref) => {
    n.parentNode = el;
    const i = ref ? el.childNodes.indexOf(ref) : -1;
    if (i < 0) el.childNodes.push(n); else el.childNodes.splice(i, 0, n);
    return n;
  };
  el.removeChild = (c) => { const i = el.childNodes.indexOf(c); if (i >= 0) el.childNodes.splice(i, 1); c.parentNode = null; return c; };
  el.cloneNode = (deep) => {
    const c = makeElement(el.tagName, ids);
    for (const a of el.attributes) c.setAttribute(a.name, a.value);
    if (deep) for (const n of el.childNodes) {
      const k = n.nodeType === 1 ? n.cloneNode(true) : makeText(n.nodeValue);
      c.appendChild(k);
    }
    return c;
  };
  if (tag === "template") {
    // A template's markup parses into .content, NOT childNodes — morph reads
    // tpl.content; a template never has children of its own.
    let content = null;
    Object.defineProperty(el, "innerHTML", { get: () => "", set: (v) => { content = parseHtml(String(v), ids); } });
    Object.defineProperty(el, "content", { get: () => content });
  } else {
    Object.defineProperty(el, "innerHTML", {
      get: () => el.textContent,
      set: (v) => { const f = parseHtml(String(v), ids); el.childNodes = [...f.childNodes]; for (const c of el.childNodes) c.parentNode = el; },
    });
  }
  return el;
}

function makeFragment() {
  return { nodeType: 11, childNodes: [], parentNode: null, get textContent() { return this.childNodes.map((n) => n.textContent).join(""); } };
}

function parseHtml(markup, ids) {
  const frag = makeFragment();
  const stack = [frag];
  let i = 0;
  const pushText = (t) => { if (t) stack[stack.length - 1].childNodes.push(makeText(t)); };
  while (i < markup.length) {
    const lt = markup.indexOf("<", i);
    if (lt < 0) { pushText(markup.slice(i)); break; }
    if (lt > i) pushText(markup.slice(i, lt));
    if (markup.startsWith("<!--", lt)) { const e = markup.indexOf("-->", lt); i = e < 0 ? markup.length : e + 3; continue; }
    const gt = markup.indexOf(">", lt);
    const raw = markup.slice(lt + 1, gt);
    i = gt + 1;
    if (raw.startsWith("/")) { if (stack.length > 1) stack.pop(); continue; }
    const self = raw.endsWith("/");
    const inner = self ? raw.slice(0, -1) : raw;
    const m = inner.match(/^([a-zA-Z][a-zA-Z0-9-]*)/);
    if (!m) continue; // stray "<" — page.html escapes these out of text, so none
    const el = makeElement(m[1], ids);
    for (const a of inner.slice(m[0].length).matchAll(/([a-zA-Z_:][-a-zA-Z0-9_:.]*)="([^"]*)"/g)) el.setAttribute(a[1], a[2]);
    const parent = stack[stack.length - 1];
    parent.childNodes.push(el);
    el.parentNode = parent;
    if (!self) stack.push(el);
  }
  return frag;
}

// ── the page under test ──────────────────────────────────────────────────
export function loadPage(opts = {}) {
  const src = readFileSync(PAGE, "utf8");
  const script = src.match(/<script>([\s\S]*)<\/script>/)[1];

  const ids = new Map();
  const hdr = makeElement("header", ids); hdr.setAttribute("id", "hdr");
  const main = makeElement("main", ids); main.setAttribute("id", "main");
  makeElement("div", ids).setAttribute("id", "menu");
  // The compound menu selectors: pre-resolved stubs, one per selector page.html
  // uses at boot or while drawing the runs list.
  const chrome = {};
  for (const sel of ["#menu-close", "#menu .nav", "#menu .nav a[href='#/perf']", "#menu-url", "#menu-token"]) chrome[sel] = makeElement("div", ids);

  const location = { hash: "", search: "", origin: "http://localhost" };
  const winListeners = {};
  const window = { addEventListener: (t, f) => { (winListeners[t] ||= []).push(f); } };
  let esListeners = {};
  const esInstances = [];
  const fetchLog = [];
  const pendingFetches = [];
  // The haptic is the part the operator asked for and the only celebration
  // instrument that can COUNT: two celebrations of the same run write the same
  // document.title, so the title cannot tell one fire from two. navigator.vibrate
  // has no test surface on a real phone (the manual row covers that); here it is
  // a stub, which is exactly what makes "exactly once" checkable.
  const vibrateCalls = [];
  const fetch = (url, init = {}) => {
    fetchLog.push(url);
    return new Promise((resolve, reject) => {
      pendingFetches.push({ url, resolve });
      init.signal?.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })));
    });
  };
  const timers = [];

  const context = {}; // closed over by the document stub below
  const document = {
    title: "swarm",
    querySelector: (sel) => (sel.startsWith("#") && !sel.includes(" ") && ids.has(sel.slice(1))) ? ids.get(sel.slice(1)) : (chrome[sel] || makeElement("div", ids)),
    createElement: (tag) => makeElement(tag, ids),
    // Loading live.js really runs it in this context (the page needs window.swarmLive);
    // perf.js just resolves — no test drives the perf views.
    head: { appendChild: (s) => { if (/live\.js(\?|$)/.test(s.src)) vm.runInContext(LIVE_JS, context, { filename: "live.js" }); s.onload && s.onload(); } },
  };
  const DOMParser = function () { this.parseFromString = (markup) => ({ documentElement: parseHtml(markup, ids).childNodes[0] }); };
  // readyState/close()/onopen: enough of the real EventSource surface for D6's
  // reconnect wiring — a fresh instance per connect() call, CONNECTING until a
  // test drives it to OPEN or CLOSED, since nothing here simulates a real socket.
  const EventSource = function () {
    const es = { readyState: EventSource.CONNECTING, addEventListener: (t, f) => { (esListeners[t] ||= []).push(f); }, close: () => { es.readyState = EventSource.CLOSED; } };
    esInstances.push(es);
    return es;
  };
  EventSource.CONNECTING = 0; EventSource.OPEN = 1; EventSource.CLOSED = 2;

  Object.assign(context, { window, document, location, fetch, DOMParser, EventSource,
    navigator: { vibrate: (p) => { vibrateCalls.push(p); return true; } },
    URLSearchParams, AbortController,
    // Intervals are captured like the timeouts — the page must not depend on
    // wall-clock time either way — but they REPEAT, so fireTimers does not null
    // one out after its first fire.
    setInterval: (fn, ms) => { timers.push({ fn, ms, every: true }); return timers.length; },
    // Timers are captured, never fired, unless a test fires them: the page must not
    // depend on wall-clock time to behave.
    setTimeout: (fn, ms) => { timers.push({ fn, ms }); return timers.length; }, clearTimeout: (id) => { if (timers[id - 1]) timers[id - 1].fn = null; },
    queueMicrotask: (f) => Promise.resolve().then(f), console });
  if (opts.perfViews) window.perfViews = opts.perfViews; // perf.js is never loaded here; stub the contract
  vm.createContext(context);
  vm.runInContext(script, context, { filename: "page.html" });

  // One macrotask turn drains every microtask chain (loadScript boot, fetch
  // then-chains, the coalescing latch) — exactly one flush per settled step.
  const flush = () => new Promise((r) => setTimeout(r, 0));
  const respond = (pred, data) => {
    const i = pendingFetches.findIndex((f) => pred(f.url));
    assert.ok(i >= 0, `no pending fetch for the expected request (log: ${fetchLog.join(", ")})`);
    const f = pendingFetches.splice(i, 1)[0];
    f.resolve({ ok: true, status: 200, json: async () => data });
  };
  const isList = (u) => /^\/api\/runs(\?|$)/.test(u);
  const isRun = (u) => /^\/api\/runs\/[^/]+\/[^/?]+(\?|$)/.test(u);
  const isPerf = (u) => u.startsWith("/api/perf");
  const isLeaf = (u) => /^\/api\/runs\/[^/]+\/[^/]+\/leaves\//.test(u);

  return {
    location, hdr, main, flush,
    fireHashchange: () => winListeners.hashchange.forEach((f) => f()),
    fireSse: (t, d) => (esListeners[t] || []).forEach((f) => f({ data: d || "{}" })),
    esCount: () => esInstances.length,
    // Drives the CURRENT (latest) EventSource — the one page.html's connect() just
    // created — since a reconnect replaces `es` with a fresh instance.
    fireEsOpen: () => { const es = esInstances[esInstances.length - 1]; es.readyState = EventSource.OPEN; es.onopen && es.onopen(); },
    fireEsError: (readyState) => { const es = esInstances[esInstances.length - 1]; if (readyState !== undefined) es.readyState = readyState; es.onerror && es.onerror(); },
    fetchLog,
    pendingCount: () => pendingFetches.length,
    fireTimers: (ms) => timers.filter((t) => t.fn && t.ms === ms).forEach((t) => { const fn = t.fn; if (!t.every) t.fn = null; fn(); }),
    listFetches: () => fetchLog.filter(isList),
    runFetches: () => fetchLog.filter(isRun),
    respondList: (data) => respond(isList, data),
    respondRun: (data) => respond(isRun, data),
    respondPerf: (data) => respond(isPerf, data),
    respondLeaf: (data) => respond(isLeaf, data),
    respond: (pred, data) => respond(pred, data),
    isPerf,
    mainText: () => main.textContent,
    // The screen the user sees is header + main together — the flicker wipes both.
    screenText: () => `${hdr.textContent}\n${main.textContent}`,
    docTitle: () => document.title,
    vibrations: () => vibrateCalls,
    seam: () => window.__swarmPage,
    snapshot: () => window.__swarmPage && window.__swarmPage.snapshot(),
  };
}

// ── fixtures ─────────────────────────────────────────────────────────────
export const RUN_URL = "#/run/C--code-tgt/TARGETRUN";
export const targetRun = () => ({
  project: "C--code-tgt", name: "TARGETRUN", groupLabel: "tgt", startedMs: Date.now() - 60_000,
  finishedMs: null, abortedMs: null, stoppedMs: null, quietWarnMs: 60_000, totals: { byState: { ok: 1 } },
  tasks: [{ id: "leaf-a", state: "ok", model: "glm", tokens: { input: 10, output: 20 }, after: [] }],
  waves: [["leaf-a"]],
});
export const listRow = (over = {}) => ({
  project: "C--code-listproj", group: "C--code-listproj", name: "LISTRUN", groupLabel: "list-label",
  active: true, startedMs: Date.now() - 1000, mtimeMs: Date.now(), finishedMs: null,
  byState: { running: 1 }, leaves: 1, waves: 1, tokens: 100, ...over,
});
export const listData = (row) => ({ clockMs: 1000, uiPollMs: 5000, grading: true, finishedTotals: {}, runs: [row] });
