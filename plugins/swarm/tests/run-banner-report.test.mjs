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

test("a run that has started nothing banners as queued, not as done", async () => {
  const { el, text } = await bannerOf({ finishedMs: null, byState: { pending: 4 } });
  assert.ok(el.getAttribute("class").includes("queued"));
  assert.ok(text.includes("nothing started yet"));
});
