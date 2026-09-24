// Rung 1 of dashboard-shared-identity: the run detail's verdict banner, and the
// report affordance for runs that rendered a report.html.
//
// These assert on the MECHANISM, not on markup presence. The check that passed
// while the previous build's action bar was unreachable asserted the bar's classes
// appeared in the right order — which stayed true when the bar scrolled off the
// bottom of a nine-wave run. So the layout-role pin below asserts `position:fixed`,
// the property that actually decides whether the operator can reach it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { readRun } from "../src/runlog.mjs";
import { createServer } from "../src/serve/server.mjs";
import { PAGE, RUN_URL, targetRun, loadPage } from "./helpers/page-harness.mjs";

const CFG = { dashboard: {} };

// A run dir the engine would have written, plus whichever report files the row wants.
function runHome(files = {}) {
  const home = mkdtempSync(join(tmpdir(), "swarm-report-"));
  const dir = join(home, "runs", "C--code-tgt", "TARGETRUN");
  mkdirSync(join(dir, "results"), { recursive: true });
  writeFileSync(join(dir, "run.log"), JSON.stringify({ type: "run-start", ts: Date.now(), tasks: [], waves: [] }) + "\n");
  for (const [name, body] of Object.entries(files)) writeFileSync(join(dir, name), body);
  return { home, dir };
}

const paint = async (over) => {
  const P = loadPage();
  await P.flush();
  P.location.hash = RUN_URL;
  P.fireHashchange();
  await P.flush();
  P.respondRun({ ...targetRun(), ...over });
  await P.flush();
  return P;
};

// ── the report affordance ────────────────────────────────────────────────

test("readRun reports report.html separately from report.md", () => {
  const { dir } = runHome({ "report.html": "<h1>long form</h1>", "report.md": "# md" });
  const run = readRun(dir, { now: Date.now() });
  assert.equal(run.reportHtmlPath, join(dir, "report.html"), "the html report is its own field");
  assert.equal(run.reportPath, join(dir, "report.md"), "report.md keeps its own field");

  const { dir: bare } = runHome({ "report.md": "# md only" });
  assert.equal(readRun(bare, { now: Date.now() }).reportHtmlPath, null, "no report.html → null, not the md path");
});

test("/api/runs/<p>/<r>/report serves report.html as written, never through mdToHtml", async () => {
  // A marker mdToHtml would mangle: a bare `#` inside the body is a markdown h1.
  const body = "<html><body><p># not a heading</p></body></html>";
  const { home } = runHome({ "report.html": body });
  const srv = createServer({ home, cfg: CFG, _estate: { current: async () => ({ version: "v", rows: [] }), onSnapshot() {}, refresh() {}, close() {}, reopen() {} } });
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  const port = srv.address().port;
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/runs/C--code-tgt/TARGETRUN/report`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type"), /text\/html/);
    assert.equal(await res.text(), body, "served byte-for-byte — it is already HTML");
  } finally { srv.close(); }
});

test("/api/runs/<p>/<r>/report is 404 when the run rendered no report.html", async () => {
  const { home } = runHome({ "digest.md": "# digest" });
  const srv = createServer({ home, cfg: CFG, _estate: { current: async () => ({ version: "v", rows: [] }), onSnapshot() {}, refresh() {}, close() {}, reopen() {} } });
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  const port = srv.address().port;
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/runs/C--code-tgt/TARGETRUN/report`);
    assert.equal(res.status, 404, "a digest is not a report — the action must not offer one");
  } finally { srv.close(); }
});

test("the action bar appears only for a run carrying report.html", async () => {
  const withReport = await paint({ finishedMs: Date.now(), reportHtmlPath: "/runs/TARGETRUN/report.html" });
  const bars = withReport.findByClass("actionbar");
  assert.equal(bars.length, 1, "one action bar");
  assert.ok(withReport.screenText().includes("Open report"), "it names the action");

  const without = await paint({ finishedMs: Date.now(), reportHtmlPath: null, digestPath: "/runs/TARGETRUN/digest.md" });
  assert.equal(without.findByClass("actionbar").length, 0, "a digest-only run gets no report bar");
});

// The regression this rung exists to prevent. The previous build rendered this bar
// inside the scrolling body with no positioning, so on a real run it sat hundreds of
// pixels below the fold and read as missing. Markup-presence checks stayed green.
test("the action bar is pinned to the viewport, not appended into the scroll", () => {
  const css = readFileSync(PAGE, "utf8").match(/\.actionbar\s*\{([^}]*)\}/);
  assert.ok(css, ".actionbar must carry its own rule");
  assert.match(css[1], /position:\s*fixed/, "a bar that scrolls with the body is unreachable on a long run");
  assert.match(css[1], /bottom:\s*0/, "pinned to the bottom edge");
  assert.match(readFileSync(PAGE, "utf8"), /main:has\(\.actionbar\)\s*\{[^}]*padding-bottom/,
    "the pinned bar must reserve its own space, or it covers the last row");
});

// ── the verdict banner ───────────────────────────────────────────────────

const tasksIn = (byState) => Object.entries(byState).flatMap(([state, n]) =>
  Array.from({ length: n }, (_, i) => ({ id: `${state}-${i}`, state, model: "glm", tokens: { input: 10, output: 20 }, after: [] })));

const bannerOf = async (over) => {
  const tasks = over.tasks ?? tasksIn(over.byState || { ok: 1 });
  const P = await paint({ ...over, tasks, waves: [tasks.map((t) => t.id)], totals: { byState: {} } });
  const b = P.findByClass("banner");
  assert.equal(b.length, 1, "exactly one banner — it is the screen's single verdict");
  return { el: b[0], text: P.screenText(), P };
};

test("a finished run banners as done and opens the digest", async () => {
  const { el, text } = await bannerOf({ finishedMs: Date.now(), digestPath: "/d.md", byState: { ok: 3 } });
  assert.ok(el.getAttribute("class").includes("ok"), "done tone");
  assert.ok(text.includes("Digest ready"), "names what is waiting");
  assert.equal(el.getAttribute("data-href"), "#/run/C--code-tgt/TARGETRUN/digest", "tapping it reaches the digest");
});

test("failed leaves outrank a finished timestamp", async () => {
  const { el, text } = await bannerOf({ finishedMs: Date.now(), byState: { ok: 1, failed: 2 } });
  assert.ok(el.getAttribute("class").includes("bad"), "failure tone, not the done tone");
  assert.ok(text.includes("2 of 3 failed"), "states the count, not just that something went wrong");
});

test("an aborted run says the engine is gone, whatever the leaves last logged", async () => {
  const { el, text } = await bannerOf({ abortedMs: Date.now(), byState: { ok: 1, running: 2 } });
  assert.ok(el.getAttribute("class").includes("bad"));
  assert.ok(text.includes("Aborted"), "an aborted run has no running leaves, whatever run.log says");
});

test("a live run with a quiet leaf banners the quiet stretch, not the running count", async () => {
  const now = Date.now();
  const tasks = [
    { id: "busy", state: "running", model: "glm", tokens: {}, after: [], lastEventMs: now - 1000 },
    { id: "stuck", state: "running", model: "glm", tokens: {}, after: [], lastEventMs: now - 600_000 },
  ];
  const { el, text } = await bannerOf({ finishedMs: null, quietWarnMs: 60_000, tasks });
  assert.ok(el.getAttribute("class").includes("slow"), "attention tone");
  assert.ok(text.includes("stuck"), "names the leaf that is quiet, not the one that is fine");
});

test("a live run with no leaf running banners the live floor, not a queued run", async () => {
  const { el, text } = await bannerOf({ finishedMs: null, byState: { pending: 4 } });
  assert.ok(!el.getAttribute("class").includes("queued"), "no tone for a state a run directory cannot be in");
  assert.ok(text.includes("0 running"), "the floor states the running count rather than claiming nothing started");
});

// ── the run's chrome stays on the run screen ─────────────────────────────

// buildNode feeds renderRunHtml a manifest node's SUBGRAPH while still passing the
// whole run, so anything run-level inside that renderer paints onto the node screen:
// a verdict mixing finishedMs/digestPath with one node's leaf counts, and an 'Open
// report' bar for a report the node screen is not showing.
const paintNode = async (over, node = "m1") => {
  const P = loadPage();
  await P.flush();
  P.location.hash = `${RUN_URL}/node/${node}`;
  P.fireHashchange();
  await P.flush();
  P.respondRun({ ...targetRun(), ...over });
  await P.flush();
  return P;
};

const subgraphRun = (over = {}) => ({
  tasks: [
    { id: "m1", kind: "manifest", state: "ok", model: "glm", tokens: { input: 10, output: 20 }, after: [] },
    { id: "m1~a", kind: "child", parent: "m1", state: "ok", model: "glm", tokens: { input: 10, output: 20 }, after: [] },
    { id: "m1~b", kind: "child", parent: "m1", state: "failed", model: "glm", tokens: { input: 10, output: 20 }, after: [] },
  ],
  ...over,
});

test("the node screen carries neither the run's verdict banner nor its report bar", async () => {
  const P = await paintNode(subgraphRun({
    finishedMs: Date.now(), digestPath: "/runs/TARGETRUN/digest.md", reportHtmlPath: "/runs/TARGETRUN/report.html",
  }));
  assert.equal(P.findByClass("banner").length, 0, "a run-level verdict over one node's subgraph is a lie, not a summary");
  assert.equal(P.findByClass("actionbar").length, 0, "the report bar belongs to the run screen");
  assert.equal(P.findByClass("graph").length, 1, "the node's own graph is what this screen is for");
});

test("the run screen still carries both, so the fix moved the chrome rather than dropping it", async () => {
  const P = await paint(subgraphRun({
    finishedMs: Date.now(), digestPath: "/runs/TARGETRUN/digest.md", reportHtmlPath: "/runs/TARGETRUN/report.html",
  }));
  assert.equal(P.findByClass("banner").length, 1, "the run's own screen has its verdict");
  assert.equal(P.findByClass("actionbar").length, 1, "and its report action");
});

// ── the tones carry their weight ─────────────────────────────────────────

// A run directory only exists once the engine has dispatched, so a RUN banner can never
// be `queued` ('nothing started yet'). A single LEAF can — it waits on upstream — so the
// tone's one producer is the leaf banner. Asserted on the mechanism: the rule exists only
// alongside that producer, and the run banner never claims a run started nothing.
test("the queued tone is produced by the leaf banner, never by the run banner", () => {
  const src = readFileSync(PAGE, "utf8");
  assert.ok(/\.banner\.queued\s*\{/.test(src), "the leaf page's waiting tone has its rule");
  const run = src.slice(src.indexOf("function bannerHtml("), src.indexOf("function runChromeHtml("));
  const leaf = src.slice(src.indexOf("function leafBannerHtml("), src.indexOf("function renderLeafHtml("));
  assert.ok(!run.includes('"queued"'), "a run banner cannot be queued");
  assert.ok(leaf.includes('tile("queued"'), "the rule's producer is the leaf banner — without it the rule is dead CSS");
  assert.ok(!src.includes("nothing started yet"), "no branch may claim a run started nothing");
});

// Ported straight from the mockup, every tile sat at 1.05-1.16 contrast against the
// page ground — visually flat, because the mockup drew them in a narrow phone frame
// with empty margins where the bright glyph did the work. At full width they vanish.
// A hex table cannot be eyeballed, so the floor is asserted.
const srgb = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
const lum = (h) => {
  const [r, g, b] = srgb(h).map((v) => (v /= 255) <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const contrast = (a, b) => {
  const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};

test("every banner tone separates from the page ground and carries a legible glyph", () => {
  const css = readFileSync(PAGE, "utf8");
  const ground = css.match(/--ground:(#[0-9a-f]{6})/)[1];

  const tones = [...css.matchAll(/\.banner(?:\.(\w+))?\s*\{\s*--bn-bg:(#[0-9a-f]{6}); --bn-br:(#[0-9a-f]{6}); --bn-ic-bg:(#[0-9a-f]{6}); --bn-ic-fg:(#[0-9a-f]{6});/g)]
    .map(([, name, bg, br, ic, fg]) => ({ name: name || "running", bg, br, ic, fg }));
  assert.equal(tones.length, 5, "one rule per tone: running, ok, slow, bad, queued");

  for (const t of tones) {
    assert.ok(contrast(t.bg, ground) >= 1.25,
      `${t.name}: tile ${t.bg} is ${contrast(t.bg, ground).toFixed(2)} against ground ${ground} — below 1.25, reads as flat page`);
    assert.ok(contrast(t.br, t.bg) >= 1.8, `${t.name}: border ${t.br} is ${contrast(t.br, t.bg).toFixed(2)} against its tile`);
    assert.ok(contrast(t.ic, t.bg) >= 1.8, `${t.name}: icon circle ${t.ic} is ${contrast(t.ic, t.bg).toFixed(2)} against its tile`);
    assert.ok(contrast(t.fg, t.ic) >= 3.0,
      `${t.name}: glyph ${t.fg} is ${contrast(t.fg, t.ic).toFixed(2)} on circle ${t.ic} — below the 3.0 legibility floor`);
  }
});
