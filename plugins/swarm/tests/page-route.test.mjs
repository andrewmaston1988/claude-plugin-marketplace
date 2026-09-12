import { test } from "node:test";
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

const PAGE = fileURLToPath(new URL("../src/serve/page.html", import.meta.url));
const LIVE_JS = readFileSync(fileURLToPath(new URL("../src/serve/live.js", import.meta.url)), "utf8");

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
function loadPage(opts = {}) {
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

  Object.assign(context, { window, document, location, fetch, DOMParser, EventSource, navigator: {},
    URLSearchParams, AbortController, setInterval: () => 0,
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
    fireTimers: (ms) => timers.filter((t) => t.fn && t.ms === ms).forEach((t) => { const fn = t.fn; t.fn = null; fn(); }),
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
    seam: () => window.__swarmPage,
    snapshot: () => window.__swarmPage && window.__swarmPage.snapshot(),
  };
}

// ── fixtures ─────────────────────────────────────────────────────────────
const RUN_URL = "#/run/C--code-tgt/TARGETRUN";
const targetRun = () => ({
  project: "C--code-tgt", name: "TARGETRUN", groupLabel: "tgt", startedMs: Date.now() - 60_000,
  finishedMs: null, abortedMs: null, stoppedMs: null, quietWarnMs: 60_000, totals: { byState: { ok: 1 } },
  tasks: [{ id: "leaf-a", state: "ok", model: "glm", tokens: { input: 10, output: 20 }, after: [] }],
  waves: [["leaf-a"]],
});
const listRow = (over = {}) => ({
  project: "C--code-listproj", group: "C--code-listproj", name: "LISTRUN", groupLabel: "list-label",
  active: true, startedMs: Date.now() - 1000, mtimeMs: Date.now(), finishedMs: null,
  byState: { running: 1 }, leaves: 1, waves: 1, tokens: 100, ...over,
});
const listData = (row) => ({ clockMs: 1000, uiPollMs: 5000, grading: true, finishedTotals: {}, runs: [row] });

// ── tests ────────────────────────────────────────────────────────────────
test("Test 1: a superseded list fetch never paints over the run screen (the race)", async () => {
  const P = loadPage();
  await P.flush(); // boot: route() → the /api/runs estate scan is in flight
  assert.equal(P.listFetches().length, 1, "boot issued one list fetch");
  P.location.hash = RUN_URL;
  P.fireHashchange();
  await P.flush();
  assert.equal(P.runFetches().length, 1, "navigation issued one run fetch");
  P.respondRun(targetRun()); // the run fetch resolves first — fast
  await P.flush();
  assert.ok(P.screenText().includes("TARGETRUN"), "step 3: the run screen is painted");
  P.respondList(listData(listRow({ name: "LISTRUN", active: false, finishedMs: Date.now() }))); // the slow estate scan lands late, out of order
  await P.flush();
  assert.ok(P.screenText().includes("TARGETRUN"), "step 5: the stale list must not have painted over the run");
});

test("Test 2: a superseded list build writes no shared state and fires no celebration", async () => {
  const P = loadPage();
  await P.flush();
  P.respondList(listData(listRow())); // commits; seenActive records LISTRUN as active
  await P.flush();
  P.fireSse("runs"); await P.flush(); // a refresh fetch goes in flight
  P.location.hash = RUN_URL;
  P.fireHashchange();
  await P.flush();
  P.respondRun(targetRun()); // the run commits
  await P.flush();
  // The stale list now lands: LISTRUN went inactive with a new group label.
  P.respondList(listData(listRow({ active: false, finishedMs: Date.now(), groupLabel: "STALELABEL" })));
  await P.flush();
  assert.equal(P.docTitle(), "swarm", "a superseded build does not celebrate");
  assert.ok(P.screenText().includes("TARGETRUN"), "the run screen is still painted");
  const snap = P.snapshot();
  assert.ok(snap, "test seam present (window.__swarmPage)");
  assert.equal(snap.lastList.runs[0].active, true, "lastList is the committed fetch, not the superseded one");
  assert.equal(snap.seenActive.get("C--code-listproj/LISTRUN"), true, "seenActive still holds the committed scan");
  assert.equal(snap.groupLabels["C--code-listproj"], "list-label", "groupLabels hold the committed labels, not the stale ones");
  assert.equal(snap.currentRun.name, "TARGETRUN", "currentRun is the run from the committed navigation");
});

test("Test 3: a 1 s tick mid-navigation repaints the committed screen, not the pending one", async () => {
  const P = loadPage();
  await P.flush();
  P.respondList(listData(listRow()));
  await P.flush();
  P.location.hash = RUN_URL;
  P.fireHashchange();
  await P.flush();
  P.respondRun(targetRun());
  await P.flush(); // the run screen is committed and painted
  assert.ok(P.screenText().includes("TARGETRUN"));
  P.location.hash = "#/";
  P.fireHashchange();
  await P.flush(); // back to the list — its fetch is slow and still pending
  assert.equal(P.listFetches().length, 2, "the list refetch is in flight");
  const s = P.seam();
  assert.ok(s, "test seam present (window.__swarmPage)");
  s.rerender(); // the 1 s clock fires here, between navigation and commit
  assert.ok(P.screenText().includes("TARGETRUN"), "the tick repainted the run — the screen on the glass, not the pending list");
});

test("Test 4: event-driven routes coalesce; a hashchange is never coalesced away", async () => {
  const P = loadPage();
  await P.flush();
  P.respondList(listData(listRow()));
  await P.flush(); // the list is committed, so SSE `runs` events will route
  const before = P.listFetches().length;
  P.fireSse("runs"); P.fireSse("runs"); P.fireSse("runs");
  await P.flush();
  assert.equal(P.listFetches().length - before, 1, "three SSE events, one list fetch");
  P.location.hash = RUN_URL;
  P.fireHashchange();
  await P.flush();
  assert.equal(P.runFetches().length, 1, "navigation issued its own fetch, not dropped by the latch");
  P.respondRun(targetRun());
  await P.flush();
  assert.ok(P.screenText().includes("TARGETRUN"), "the hashchange's target screen committed");
  P.respondList(listData(listRow({ name: "LISTRUN", active: false, finishedMs: Date.now() }))); // the coalesced fetch resolves last
  await P.flush();
  assert.ok(P.screenText().includes("TARGETRUN"), "and its stale build did not repaint");
});

test("Test 6: setHtml/setHeader/setSvg are called only from the commit layer", () => {
  const src = readFileSync(PAGE, "utf8");
  const script = src.match(/<script>([\s\S]*)<\/script>/)[1];
  const code = stripStringsAndComments(script);
  const lines = code.split("\n");
  // Both forms reset attribution: a `function NAME` declaration AND a top-level
  // `const NAME = (...) =>` arrow. Matching only the former was a blind spot: an
  // arrow paint helper written textually after commitView inherited its name and
  // passed while violating the invariant (code review, 2026-09-09).
  const decl = /^(\s*)(?:(async\s+)?function\s+([A-Za-z_$][\w$]*)|(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?\()/;
  // The function a line sits in: the last `function NAME(` declaration at or
  // above it. (page.html declares functions at IIFE top level only; inner
  // helpers are const arrows, which do not reset the attribution.) A token in
  // a comment or a string literal cannot reach here — the stripper blanks
  // both — so this matches call position, not the token's mere presence.
  const enclosing = new Array(lines.length);
  let cur = null;
  lines.forEach((l, i) => { const m = l.match(decl); if (m) cur = m[3] || m[4]; enclosing[i] = cur; });
  const ALLOWED = { setHtml: ["setHeader", "commitView", "rerender"], setHeader: ["commitView", "rerender"], setSvg: ["drawRail"] };
  for (const [name, allowed] of Object.entries(ALLOWED)) {
    const re = new RegExp(`\\b${name}\\s*\\(`, "g");
    let m;
    while ((m = re.exec(code)) !== null) {
      const lineNo = code.slice(0, m.index).split("\n").length - 1;
      if (lines[lineNo].includes(`function ${name}`)) continue; // the primitive's own definition
      const fn = enclosing[lineNo];
      assert.ok(fn, `${name}( at line ${lineNo + 1} sits outside any function`);
      assert.ok(allowed.includes(fn),
        `${name}( is called in ${fn} (line ${lineNo + 1}); the paint primitive belongs to the commit layer only (${allowed.join(", ")}) — extending ALLOWED is a deliberate edit with a reason`);
    }
  }
});

// Blank the CONTENT of every comment, string, template and regex literal with
// spaces (newlines preserved, so line numbers still resolve), leaving pure
// code. Handles nested template interpolations and regex-vs-division by the
// usual "previous significant character" rule.
function stripStringsAndComments(js) {
  let out = "";
  let i = 0;
  let mode = "code"; // code | interp (inside ${ }) | sq | dq | tpl | re
  let depth = 0; // {} depth inside the innermost interpolation
  let reClass = false; // inside a regex [...] class
  const stack = [];
  let lastCode = "";
  const blank = () => { out += js[i] === "\n" ? "\n" : " "; i++; };
  while (i < js.length) {
    const c = js[i], n = js[i + 1];
    if (mode === "code" || mode === "interp") {
      if (c === "/" && n === "/") { while (i < js.length && js[i] !== "\n") blank(); continue; }
      if (c === "/" && n === "*") { blank(); blank(); while (i < js.length && !(js[i] === "*" && js[i + 1] === "/")) blank(); blank(); blank(); continue; }
      if (c === "'") { stack.push(mode); mode = "sq"; blank(); continue; }
      if (c === '"') { stack.push(mode); mode = "dq"; blank(); continue; }
      if (c === "`") { stack.push(mode); mode = "tpl"; blank(); continue; }
      if (c === "/" && !/[\w$)\]]/.test(lastCode)) { stack.push(mode); mode = "re"; reClass = false; blank(); continue; }
      if (mode === "interp" && c === "{") { depth++; out += c; i++; lastCode = c; continue; }
      if (mode === "interp" && c === "}") {
        if (depth > 0) { depth--; out += c; i++; lastCode = c; continue; }
        mode = stack.pop(); blank(); continue; // close of ${ }
      }
      out += c; i++; if (!/\s/.test(c)) lastCode = c; continue;
    }
    if (mode === "sq" || mode === "dq") {
      const q = mode === "sq" ? "'" : '"';
      if (c === "\\") { blank(); blank(); continue; }
      if (c === q) mode = stack.pop();
      blank(); continue;
    }
    if (mode === "tpl") {
      if (c === "\\") { blank(); blank(); continue; }
      if (c === "`") { mode = stack.pop(); blank(); continue; }
      if (c === "$" && n === "{") { stack.push("tpl"); mode = "interp"; depth = 0; blank(); blank(); continue; }
      blank(); continue;
    }
    // mode === "re"
    if (c === "\\") { blank(); blank(); continue; }
    if (c === "[") { reClass = true; blank(); continue; }
    if (c === "]") { reClass = false; blank(); continue; }
    if (c === "/" && !reClass) { mode = stack.pop(); blank(); while (i < js.length && /[\w$]/.test(js[i])) blank(); continue; }
    blank(); continue;
  }
  return out;
}

// ── cost badges + the leaf chip ──────────────────────────────────────────
// Badge placement is a hard rule: 💲 bands live ONLY on the perf pages and
// the model detail view. Run and leaf rows read a run; they are never
// compared, so a badge there is clutter. These tests fail if a later edit
// scatters badges back onto them.

const allNodes = (el, out = []) => { for (const n of el.childNodes || []) { out.push(n); allNodes(n, out); } return out; };
const badgesIn = (el) => allNodes(el).filter((n) => n.nodeType === 1 && (n.getAttribute("class") || "").split(/\s+/).includes("cbadge"));
const chipHref = (el, href) => allNodes(el).find((n) => n.nodeType === 1 && (n.getAttribute("class") || "").split(/\s+/).includes("chip") && n.getAttribute("data-href") === href);

// A /api/perf payload with one measured model (4.4× → band 2 → 💲💲) and one
// unmeasured tier (band null → the em dash, never a blank that reads as
// dominated).
const perfPayload = () => ({
  grading: true, path: "x", lines: 2, rows: 2, priorWeight: 4,
  aspects: [], universals: ["adherence", "handoff", "truthfulness", "depth"], domains: [],
  filters: { aspect: null, model: null, domain: null },
  overall: [
    { model: "m-dear", combined: 7.9, n: 6, provisional: false, outcomes: { completed: 6 }, wtds: { adherence: 7.9, handoff: 7.9, truthfulness: 7.9, depth: 7.9 } },
    { model: "sonnet", combined: 7.2, n: 2, provisional: true, outcomes: { completed: 2 }, wtds: { adherence: 7.2, handoff: 7.2, truthfulness: 7.2, depth: 7.2 } },
  ],
  report: [],
  views: {
    coverage: { aspects: [], models: [], cells: [] },
    reliability: [],
    leaders: [],
    cost: {
      bands: [2, 5],
      points: [
        { model: "m-dear", wtd: 7.9, n: 6, multiplier: 4.4, band: 2, onFrontier: true, dominatedBy: null, thin: false },
        { model: "sonnet", wtd: 7.2, n: 2, multiplier: null, band: null, onFrontier: false, dominatedBy: null, thin: false },
      ],
      spread: [
        { model: "m-dear", mult: 4.4, band: 2, requests: 300, measuredRequests: 300, weeks: 1, measuredWeeks: 1, thin: false },
        { model: "sonnet", mult: null, band: null, requests: 150, measuredRequests: 0, weeks: 1, measuredWeeks: 0, thin: true },
      ],
    },
  },
});

test("badges: the perf overall list carries the band badge and the unmeasured em dash", async () => {
  const P = loadPage();
  await P.flush();
  P.respondList(listData(listRow()));
  await P.flush();
  P.location.hash = "#/perf";
  P.fireHashchange();
  await P.flush();
  P.respondPerf(perfPayload());
  await P.flush();
  const badges = badgesIn(P.main);
  assert.equal(badges.length, 2, "one badge per ranked row");
  assert.deepEqual(badges.map((b) => b.textContent), ["💲💲", "—"],
    "measured reads its band (💲💲 at 4.4×), unmeasured reads —, never a blank");
});

test("badges: run rows and leaf rows carry none — the screen a run is READ on stays clean", async () => {
  const P = loadPage();
  await P.flush();
  P.respondList(listData(listRow()));
  await P.flush();
  P.location.hash = RUN_URL;
  P.fireHashchange();
  await P.flush();
  P.respondRun(targetRun());
  await P.flush();
  assert.ok(P.screenText().includes("TARGETRUN"), "the run screen painted");
  assert.equal(badgesIn(P.main).length + badgesIn(P.hdr).length, 0, "no badge on the run screen");
  assert.ok(!P.screenText().includes("💲"), "no 💲 glyph anywhere on the run screen");
  // The leaf: the model chip is now a link, and it stays PLAIN TEXT — no badge rides it.
  P.location.hash = "#/run/C--code-tgt/TARGETRUN/leaf/leaf-a";
  P.fireHashchange();
  await P.flush();
  P.respondRun(targetRun());
  P.respondLeaf({ id: "leaf-a", model: "glm", ok: true, prompt: "secret prompt", output: "ten bullets" });
  await P.flush();
  const chip = chipHref(P.main, "#/perf/model/glm");
  assert.ok(chip, "the leaf's model chip is clickable, navigating to that model's breakdown");
  assert.equal(chip.textContent, "glm", "the chip stays plain text");
  assert.equal(badgesIn(P.main).length + badgesIn(P.hdr).length, 0, "no badge on the leaf screen");
  assert.ok(!P.screenText().includes("💲"), "no 💲 glyph anywhere on the leaf screen");
});

test("cost view: the fifth pill routes, the server's screen draws, and the foot names the config", async () => {
  const P = loadPage({ perfViews: { costScreen: () => `<div class="cost">the cards and the list</div>` } });
  await P.flush();
  P.respondList(listData(listRow()));
  await P.flush();
  P.location.hash = "#/perf/cost";
  P.fireHashchange();
  await P.flush();
  P.respondPerf(perfPayload());
  await P.flush();
  assert.ok(P.screenText().includes("the cards and the list"), "the perf.js widget rendered");
  assert.equal(activeSegLabel(P.main), "cost", "the cost pill is the selected view");
  assert.ok(P.screenText().includes("provider.cloud.ollama.costBands"), "the foot names the config key");
});

// ── the perf view switcher ────────────────────────────────────────────────
// It lives in page.html (not perf.js), so this harness reaches it through the
// real render path — which is also what makes the cold-load row below possible.
const segTags = (el, tag) => allNodes(el).filter((n) => n.nodeType === 1 && n.tagName === tag);
const segLabels = (el) => segTags(el, "TEXT").filter((n) => (n.getAttribute("class") || "").startsWith("seg-label"));
const activeSegLabel = (el) => {
  const on = segLabels(el).filter((n) => (n.getAttribute("class") || "").split(/\s+/).includes("on"));
  assert.equal(on.length, 1, `exactly one pill must be active, found ${on.length}`);
  return on[0].textContent;
};
const segHits = (el) => segTags(el, "RECT").filter((n) => n.getAttribute("data-href"));
const indicator = (el) => segTags(el, "RECT").find((n) => (n.getAttribute("class") || "") === "seg-ind");
const rail = (el) => segTags(el, "RECT").find((n) => (n.getAttribute("class") || "") === "seg-rail");

const gotoPerf = async (P, hash) => {
  P.location.hash = hash;
  P.fireHashchange();
  await P.flush();
  P.respondPerf(perfPayload());
  await P.flush();
};

test("switcher: one pill per view, exactly one active, and it matches the route", async () => {
  const cases = [["#/perf", "rank"], ["#/perf/coverage", "coverage"], ["#/perf/reliability", "reliability"], ["#/perf/leaders", "leaders"], ["#/perf/cost", "cost"]];
  for (const [hash, label] of cases) {
    const P = loadPage({ perfViews: Object.fromEntries(["coverageGrid", "reliabilityBars", "leadersList", "costScreen"].map((k) => [k, () => "<div></div>"])) });
    await P.flush();
    P.respondList(listData(listRow()));
    await P.flush();
    await gotoPerf(P, hash);
    assert.equal(segLabels(P.main).length, cases.length, `${hash}: one label per view — a dropped view still renders "correctly" otherwise`);
    assert.equal(activeSegLabel(P.main), label, `${hash}: the active pill`);
    const hit = segHits(P.main).find((r) => r.getAttribute("data-href") === hash);
    assert.ok(hit, `${hash}: a transparent hit rect carries the route — a <text> hit area is glyphs only, not a thumb target`);
  }
});

test("switcher: the indicator sits on the active pill, pills tile without overlapping, and nothing is drawn outside the canvas", async () => {
  const geo = async (hash) => {
    const P = loadPage({ perfViews: Object.fromEntries(["coverageGrid", "reliabilityBars", "leadersList", "costScreen"].map((k) => [k, () => "<div></div>"])) });
    await P.flush();
    P.respondList(listData(listRow()));
    await P.flush();
    await gotoPerf(P, hash);
    const hits = segHits(P.main).map((r) => ({ x: Number(r.getAttribute("x")), w: Number(r.getAttribute("width")), href: r.getAttribute("data-href") }));
    const ind = indicator(P.main);
    const tx = Number(/translate\(([-\d.]+)/.exec(ind.getAttribute("transform"))[1]);
    const svg = segTags(P.main, "SVG")[0];
    const vbW = Number(svg.getAttribute("viewBox").split(" ")[2]);
    const r = rail(P.main);
    const railBox = r ? { x: Number(r.getAttribute("x")), w: Number(r.getAttribute("width")), h: Number(r.getAttribute("height")) } : null;
    return { hits, ind: { x: tx, w: Number(ind.getAttribute("width")), h: Number(ind.getAttribute("height")) }, vbW, railBox };
  };
  const rank = await geo("#/perf");
  const pill = (g, href) => g.hits.find((h) => h.href === href);
  assert.deepEqual({ x: rank.ind.x, w: rank.ind.w }, { x: pill(rank, "#/perf").x, w: pill(rank, "#/perf").w }, "the indicator is the active pill's box");
  for (let i = 1; i < rank.hits.length; i++) {
    assert.ok(rank.hits[i].x >= rank.hits[i - 1].x + rank.hits[i - 1].w, `pill ${i} starts at or after pill ${i - 1} ends — no overlap`);
  }
  const last = rank.hits[rank.hits.length - 1];
  assert.ok(rank.vbW >= last.x + last.w, "the viewBox covers the last pill — the one way a scaled layout can still clip");
  // The rail is what makes this read as one control rather than floating labels
  // with a highlight behind them. It shipped missing once; nothing caught it.
  assert.ok(rank.railBox, "a rail rect is drawn");
  const first = rank.hits[0];
  assert.ok(first.x >= rank.railBox.x, "the first pill starts inside the rail, not on its edge");
  assert.ok(last.x + last.w <= rank.railBox.x + rank.railBox.w, "and the last pill ends inside it");
  // HEIGHT, not width: an indicator's width is one pill's and is always narrower
  // than the track, so a width comparison passes even when the indicator fills
  // the rail top-to-bottom and the track disappears behind it.
  assert.ok(rank.ind.h < rank.railBox.h, `the indicator is inset within the rail (${rank.ind.h} < ${rank.railBox.h}), never the full track height`);
  // The moving part: an indicator rendered at a constant x looks right on the
  // default view and wrong on every other one.
  const cost = await geo("#/perf/cost");
  assert.notEqual(cost.ind.x, rank.ind.x, "the indicator moves with the active view");
  assert.deepEqual({ x: cost.ind.x, w: cost.ind.w }, { x: pill(cost, "#/perf/cost").x, w: pill(cost, "#/perf/cost").w }, "…onto the cost pill's box");
});

test("switcher: renders on a COLD #/perf load with window.perfViews never stubbed", async () => {
  // The blocker this guards: perf.js is loaded by loadPerfJs() on the four new
  // views and the model page only. A switcher built there would be undefined on
  // the rank and aspect routes. The old seam ("perf.js is never loaded here;
  // stub the contract") is exactly what hid that, so this row stubs nothing.
  const P = loadPage();
  await P.flush();
  P.respondList(listData(listRow()));
  await P.flush();
  await gotoPerf(P, "#/perf");
  assert.equal(segLabels(P.main).length, 5, "the switcher rendered without perf.js being loaded at all");
  assert.equal(activeSegLabel(P.main), "rank");
});

// Events arriving faster than /api/runs answers must still paint. With only a
// microtask coalesce, each event started its own fetch; every response landed
// already superseded, routeGuard discarded it, and the list never repainted.
// Drives it with "runs" (a snapshot-version broadcast), not "run" — P3 drops
// the list view's reaction to per-run events entirely, so "runs" is the only
// event left that can still starve the list under a fast burst.
test("Test 9: SSE events faster than the list answers still commit fresh data, one fetch at a time", async () => {
  const P = loadPage();
  await P.flush();
  P.respondList(listData(listRow()));
  await P.flush();
  for (let i = 0; i < 4; i++) {
    P.fireSse("runs"); await P.flush();
    P.fireSse("runs"); await P.flush();
    assert.ok(P.pendingCount() <= 1, `never more than one list fetch in flight (iteration ${i})`);
    P.respondList(listData(listRow({ name: `FRESH${i}` })));
    await P.flush();
  }
  assert.ok(/FRESH\d/.test(P.screenText()), "a response from the burst committed");
});

// D3's page half: the list view no longer refetches on every per-run `run`
// event (root cause item 1 — that is what starved the page under live runs).
// It refreshes on `runs` only, the snapshot-changed broadcast.
test("P3: the list view ignores `run` events and refreshes on `runs` only", async () => {
  const P = loadPage();
  await P.flush();
  P.respondList(listData(listRow()));
  await P.flush();
  const before = P.listFetches().length;
  P.fireSse("run"); await P.flush();
  assert.equal(P.listFetches().length, before, "a per-run `run` event starts no list fetch on the list view");
  P.fireSse("runs"); await P.flush();
  assert.equal(P.listFetches().length, before + 1, "a `runs` event starts exactly one list fetch");
});

// D6: reconnect on a fatal CLOSE only — the browser's own retry already covers
// CONNECTING — with backoff, and a catch-up list fetch once the new connection
// opens, so events missed during the gap are not silently lost.
test("P4: EventSource reconnect — CLOSED backs off and reconnects, CONNECTING is left alone, open triggers a catch-up refresh", async () => {
  const P = loadPage();
  await P.flush();
  P.respondList(listData(listRow()));
  await P.flush();

  // A CONNECTING-state error is the browser's own retry in progress — connect()
  // must not double up on top of it.
  const esBefore = P.esCount();
  P.fireEsError(0 /* CONNECTING */);
  await P.flush();
  assert.equal(P.esCount(), esBefore, "no reconnect scheduled while the browser is already retrying");

  // A CLOSED error is fatal — the browser has given up. connect() closes,
  // schedules one reconnect after reconnectDelay(0) = 1000ms, and does so once.
  P.fireEsError(2 /* CLOSED */);
  await P.flush();
  assert.equal(P.esCount(), esBefore, "no new EventSource until the backoff timer fires");
  P.fireTimers(1000);
  await P.flush();
  assert.equal(P.esCount(), esBefore + 1, "exactly one reconnect after reconnectDelay(0)");

  // The next `open` on the new connection is the catch-up: a fresh list fetch,
  // covering whatever `runs`/`run` events were missed during the gap.
  const before = P.listFetches().length;
  P.fireEsOpen();
  await P.flush();
  assert.equal(P.listFetches().length, before + 1, "the reconnect's open triggers one catch-up list fetch");
});

test("Test 10: a hung list request times out into the error panel and frees the next refresh", async () => {
  const P = loadPage();
  await P.flush();
  P.respondList(listData(listRow()));
  await P.flush();
  P.fireSse("runs"); await P.flush();
  assert.equal(P.pendingCount(), 1, "the refresh is in flight");
  P.fireTimers(20000); await P.flush();
  assert.ok(/timed out/.test(P.screenText()), "the error panel names the timeout");
  const before = P.listFetches().length;
  P.fireSse("runs"); await P.flush();
  assert.equal(P.listFetches().length - before, 1, "the next event starts a new fetch");
});
