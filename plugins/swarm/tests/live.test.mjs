import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

// live.js is a browser static, never imported as a module — load it in a bare
// vm context the way the real page does (a `window` global and nothing else),
// then assert against the contract it hangs off `window.swarmLive`.
const LIVE_JS = fileURLToPath(new URL("../src/serve/live.js", import.meta.url));
const PAGE_HTML = fileURLToPath(new URL("../src/serve/page.html", import.meta.url));

function loadLive() {
  const context = { window: {} };
  vm.createContext(context);
  vm.runInContext(readFileSync(LIVE_JS, "utf8"), context, { filename: "live.js" });
  return context.window.swarmLive;
}

test("waveOpen: open unless manually closed — size and settledness have no say (L1)", () => {
  const { waveOpen } = loadLive();
  const closedWaves = new Set(["w-closed"]);
  assert.equal(waveOpen("w-open", closedWaves), true);
  assert.equal(waveOpen("w-closed", closedWaves), false);
  // A 12-member wave and a wave whose tasks are all `ok` have no representation in this
  // signature at all — that absence is defect (c)'s fix: `big`/`settled` cannot exist
  // here to force a collapse.
  assert.equal(waveOpen("w-big-12-members", closedWaves), true);
  assert.equal(waveOpen("w-all-settled", closedWaves), true);
});

test("projectOpen: closed unless manually opened — the (d) inversion (L2)", () => {
  const { projectOpen } = loadLive();
  const openProjects = new Set(["p-open"]);
  assert.equal(projectOpen("p-open", openProjects), true);
  assert.equal(projectOpen("p-untouched", openProjects), false);
});

test("reconnectDelay: doubles from 1s, capped at 30s (L2)", () => {
  const { reconnectDelay } = loadLive();
  assert.deepEqual([0, 1, 2, 3, 4, 5, 6].map(reconnectDelay), [1000, 2000, 4000, 8000, 16000, 30000, 30000]);
});

test("elapsedText: running moves with now; finished is fixed regardless of now; pending is null (L3)", () => {
  const { elapsedText } = loadLive();
  const running = { state: "running", startedMs: 1000 };
  assert.notEqual(elapsedText(running, 2000), elapsedText(running, 3000));
  const finished = { state: "ok", durationMs: 5000 };
  assert.equal(elapsedText(finished, 10_000), elapsedText(finished, 999_000));
  assert.equal(elapsedText({ state: "pending" }, 10_000), null);
});

test("quietSecs: only a running task with lastEventMs reports an age, and it moves with now (L4)", () => {
  const { quietSecs } = loadLive();
  const running = { state: "running", lastEventMs: 0 };
  assert.equal(quietSecs(running, 60_000), 60);
  assert.notEqual(quietSecs(running, 60_000), quietSecs(running, 61_000));
  assert.equal(quietSecs({ state: "ok", lastEventMs: 0 }, 60_000), null);
});

test("agoText: the existing ago() thresholds preserved exactly — 59s/61s/3601s/86401s (L5)", () => {
  const { agoText } = loadLive();
  const now = 100_000_000;
  assert.equal(agoText(now - 59_000, now), "59s ago");
  assert.equal(agoText(now - 61_000, now), "1 min ago");
  assert.equal(agoText(now - 3601_000, now), "1 h ago");
  assert.equal(agoText(now - 86401_000, now), "1 d ago");
});

test("runEnded/shouldPoll: each terminal field on its own, a run not yet fetched, and the runs-list always polls (L6)", () => {
  const { runEnded, shouldPoll } = loadLive();
  const open = { finishedMs: null, abortedMs: null, stoppedMs: null };
  assert.equal(runEnded(open), false);
  assert.equal(shouldPoll({ name: "run" }, open, 0), true);
  for (const field of ["finishedMs", "abortedMs", "stoppedMs"]) {
    const ended = { ...open, [field]: 123 };
    assert.equal(runEnded(ended), true, field);
    assert.equal(shouldPoll({ name: "run" }, ended, 0), false, field);
  }
  assert.equal(shouldPoll({ name: "run" }, null, 0), false, "no run fetched yet");
  assert.equal(shouldPoll({ name: "runs" }, null, 0), true, "the estate view has no single run to end");
});

test("projectOrder: live projects rank by newest live startedMs, not mtime; finished-only projects trail, by mtime (L8)", () => {
  const { projectOrder } = loadLive();
  // p-old-mtime's live row started LATER than p-new-mtime's, but its mtime is older —
  // must still lead, or the group order flaps on whichever engine last wrote an event.
  const byProject = new Map([
    ["p-new-mtime", [{ active: true, startedMs: 1000, mtimeMs: 9000 }]],
    ["p-old-mtime", [{ active: true, startedMs: 2000, mtimeMs: 1000 }]],
    ["p-finished-recent-mtime", [{ active: false, startedMs: 500, mtimeMs: 8000 }]],
  ]);
  // Array.from: projectOrder's array is built in live.js's vm realm, whose Array.prototype
  // differs from this file's — deepEqual treats that as "not reference-equal" even with
  // identical contents; normalize into the host realm before comparing.
  assert.deepEqual(Array.from(projectOrder(byProject)), ["p-old-mtime", "p-new-mtime", "p-finished-recent-mtime"]);

  const finishedOnly = new Map([
    ["p-a", [{ active: false, mtimeMs: 1000 }]],
    ["p-b", [{ active: false, mtimeMs: 2000 }]],
  ]);
  assert.deepEqual(Array.from(projectOrder(finishedOnly)), ["p-b", "p-a"]);
});

test("loadScript: resolves on load, rejects on error rather than swallowing it (L7)", async () => {
  // Pins the contract page.html's own bootstrap loader must satisfy — it cannot
  // depend on this copy for loading live.js itself (chicken-and-egg), but the
  // reject-on-error behaviour is what today's loadPerfJs gets wrong.
  const { loadScript } = loadLive();
  let created;
  const fakeDoc = { createElement: () => { created = {}; return created; }, head: { appendChild: () => {} } };

  const ok = loadScript("/live.js", fakeDoc);
  created.onload();
  await assert.doesNotReject(ok);

  const err = loadScript("/live.js", fakeDoc);
  created.onerror();
  await assert.rejects(err);
});

test("routeGuard: only the exact-latest sequence commits — anything older, or ahead of the counter, discards (L9)", () => {
  const { routeGuard } = loadLive();
  assert.equal(routeGuard(1, 1), true, "the newest sequence commits");
  assert.equal(routeGuard(1, 2), false, "an older sequence discards");
  assert.equal(routeGuard(2, 2), true, "the new latest commits once the counter advanced");
  assert.equal(routeGuard(2, 3), false, "a sequence equal to a superseded latest discards after a further increment");
  assert.equal(routeGuard(0, 0), true, "the first boot commits");
  assert.equal(routeGuard(3, 2), false, "a sequence the counter never issued discards — `>=` here is the off-by-one that lets stale builds through");
});

test("singleFlight: a burst during a build earns exactly one trailing build, and the flight frees after it (L10)", async () => {
  const { singleFlight } = loadLive();
  const settle = [];
  let ran = 0;
  const request = singleFlight(() => { ran++; return new Promise((r) => settle.push(r)); });
  const tick = () => new Promise((r) => setTimeout(r, 0));
  request(); await tick();
  assert.equal(ran, 1, "the first request builds");
  request(); request(); request(); request(); await tick();
  assert.equal(ran, 1, "requests during a build start nothing");
  settle.shift()(); await tick();
  assert.equal(ran, 2, "exactly one trailing build for the whole burst");
  settle.shift()(); await tick();
  assert.equal(ran, 2, "no burst during the trailing build, no third");
  request(); await tick();
  assert.equal(ran, 3, "the flight freed — a later request builds at once");
  settle.shift()();
});

// ── show-all: the Show all N row and the expand query it drives ───────────

test("showAllRow: only an open stack with hidden finished runs and not already expanded shows the row (T5)", () => {
  const { showAllRow } = loadLive();
  const cases = [
    // open,  total, shown, already expanded → row?
    [true, 303, 10, false, true, "open, truncated, not expanded"],
    [true, 10, 10, false, false, "nothing hidden — a useless Show all 10"],
    [true, 303, 303, true, false, "already showing all"],
    [false, 303, 10, false, false, "stack is collapsed"],
  ];
  for (const [open, total, shown, expanded, want, why] of cases) {
    const set = expanded ? new Set(["g"]) : new Set();
    assert.equal(showAllRow("g", { open, total, shown, expanded: set }), want, why);
  }
});

test("expandQuery: the expand params compose with q() — token and expand both land in the URL (T7)", () => {
  const { expandQuery } = loadLive();
  assert.equal(expandQuery(new Set()), "", "no expansion: the bare path, exactly as before");
  const expanded = new Set(["C--code-alpha", "C--code-beta x"]);
  // The page composes q(`/api/runs${expandQuery(ui.expandedProjects)}`) — expand is
  // spliced into the path BEFORE q() appends the token, so both survive. A replica
  // of page.html's q pins the composed shape; the page-side wiring is pinned below.
  const TOKEN = "s3cret";
  const q = (p) => `${p}${p.includes("?") ? "&" : "?"}t=${encodeURIComponent(TOKEN)}`;
  const url = q(`/api/runs${expandQuery(expanded)}`);
  assert.match(url, /expand=C--code-alpha/, "the token never crowds the expand params out");
  assert.match(url, /expand=C--code-beta%20x/, "group names are encoded, never raw");
  assert.match(url, /[?&]t=s3cret/, "the auth token rides along");
});

test("collapsing a project drops its expansion — the next fetch's query carries no expand for it (T6)", () => {
  const { expandQuery } = loadLive();
  // The page's own state machine: tapping Show all adds the group; the project
  // toggle's collapse deletes it. Asserted on the QUERY the next fetch builds,
  // never on what renders — the stale-expansion bug is invisible on screen.
  const expanded = new Set(["C--code-alpha", "C--code-beta"]);
  assert.match(expandQuery(expanded), /expand=C--code-alpha/, "expanded: the fetch asks for alpha uncapped");
  expanded.delete("C--code-alpha"); // the collapse the project toggle performs
  assert.doesNotMatch(expandQuery(expanded), /expand=C--code-alpha/, "collapsed: no expand for alpha on the next fetch — a stale expansion keeps a 300-row payload polling forever");
  assert.match(expandQuery(expanded), /expand=C--code-beta/, "an untouched expansion survives another project's collapse");
});

// Source pins: the page-side wiring the pure functions cannot see. serve.test.mjs
// already asserts on page.html's body, so reading the page is established practice.
// ── header run count: the third figure must equal the disk total, not the
//    rendered set — same falling-number bug, one field over ─────────────────

test("headerRunCount: the count does not fall when the per-group cap bites — disk total, not runs.length (H1)", () => {
  const { headerRunCount } = loadLive();
  // finishedTotals holds the disk total per group (server.mjs:202-203). The
  // rendered `runs` array is the capped set (finishedPerProject=10 by default).
  // A count from runs.length under-reports by exactly the size of the overflow.
  const finishedTotals = { "p-big": 47, "p-small": 3 };
  const active = [];
  // What the page renders: 10 of the 47 finished in p-big, plus all 3 of p-small.
  const renderedRuns = Array.from({ length: 10 }, (_, i) => ({ project: "p-big" })).concat(
    Array.from({ length: 3 }, (_, i) => ({ project: "p-small" })),
  );
  const fromRuns = renderedRuns.length;
  const fromDisk = headerRunCount(finishedTotals, active);
  assert.equal(fromRuns, 13, "the rendered set is the capped 13 — that is the bug");
  assert.equal(fromDisk, 50, "the honest total is the full 50 — what the header must show");
  assert.notEqual(fromDisk, fromRuns, "the count must NOT match the rendered array length");
});

test("headerRunCount: active runs are added, not folded in — finishedTotals holds finished only (H2)", () => {
  const { headerRunCount } = loadLive();
  const finishedTotals = { "p": 2 };
  const active = [{ project: "p" }];
  assert.equal(headerRunCount(finishedTotals, active), 3, "two finished plus one active = 3");
  assert.notEqual(headerRunCount(finishedTotals, []), 3, "using finishedTotals alone would have returned 2");
});

test("header: no token figure remains — the third figure is a run count, not fmtTok() (H3)", () => {
  const page = readFileSync(PAGE_HTML, "utf8");
  // The header is the `<div class="title"...>` block. Asserting on the full
  // page would catch the run-row token totals at :428 — those have a referent
  // (per-run tokens) and stay.
  const headerMatch = page.match(/<div class="title"[^>]*>[\s\S]*?<\/div>/);
  assert.ok(headerMatch, "the header block exists");
  const header = headerMatch[0];
  // Token rendering: the fmtTok helper emits suffixes like "1.2M", "456k", "789".
  // The run count is a plain integer — no suffix at all.
  assert.doesNotMatch(header, /fmtTok/, "fmtTok must not be called from the header");
  assert.doesNotMatch(header, /\b\d+(?:\.\d+)?[Mk]\b/, "no M/k token suffix in the header");
});

// ── rail transitive reduction: a fan-in draws once, through the nearest
//    join, never a redundant line from every ancestor (R1-R4) ───────────────

test("reduceEdges: platform-review fan-in — digest narrows to {join}, join keeps its three, dash-* keep {harness} (R1)", () => {
  const { reduceEdges } = loadLive();
  const targetsByKey = new Map([
    ["scale-copy", new Set()],
    ["harness", new Set(["scale-copy"])],
    ["dash-wasm", new Set(["harness"])],
    ["dash-api", new Set(["harness"])],
    ["graph-view", new Set(["harness"])],
    ["join", new Set(["dash-wasm", "dash-api", "graph-view"])],
    ["__digest", new Set(["scale-copy", "harness", "dash-wasm", "dash-api", "graph-view", "join"])],
  ]);
  const reduced = reduceEdges(targetsByKey);
  assert.deepEqual([...reduced.get("__digest")], ["join"], "digest draws one line, through join, not six");
  assert.deepEqual(new Set(reduced.get("join")), new Set(["dash-wasm", "dash-api", "graph-view"]), "join's own fan-in is genuine — all three survive");
  for (const d of ["dash-wasm", "dash-api", "graph-view"]) {
    assert.deepEqual([...reduced.get(d)], ["harness"], `${d} keeps its single upstream`);
  }
});

test("reduceEdges: ar/verify/impl chain — impl drops the redundant ar edge, digest narrows to impl (R2)", () => {
  const { reduceEdges } = loadLive();
  const targetsByKey = new Map([
    ["ar", new Set()],
    ["verify", new Set(["ar"])],
    ["impl", new Set(["ar", "verify"])],
    ["__digest", new Set(["ar", "verify", "impl"])],
  ]);
  const reduced = reduceEdges(targetsByKey);
  assert.deepEqual([...reduced.get("impl")], ["verify"], "ar is reachable via verify — the direct ar->impl edge is redundant");
  assert.deepEqual([...reduced.get("__digest")], ["impl"], "digest narrows through the deepest node");
});

test("reduceEdges: a genuine diamond survives — d's fan-in from b and c is NOT redundant (R3)", () => {
  const { reduceEdges } = loadLive();
  const targetsByKey = new Map([
    ["a", new Set()],
    ["b", new Set(["a"])],
    ["c", new Set(["a"])],
    ["d", new Set(["b", "c"])],
  ]);
  const reduced = reduceEdges(targetsByKey);
  assert.deepEqual(new Set(reduced.get("d")), new Set(["b", "c"]), "neither b nor c is an ancestor of the other — both edges are real");
});

test("reduceEdges: a malformed 2-cycle returns without throwing (R4)", () => {
  const { reduceEdges } = loadLive();
  const targetsByKey = new Map([
    ["x", new Set(["y"])],
    ["y", new Set(["x"])],
  ]);
  assert.doesNotThrow(() => reduceEdges(targetsByKey));
});

test("page wiring: the runs fetch splices expandQuery inside q()'s argument, and collapse drops the expansion (T6/T7)", () => {
  const page = readFileSync(PAGE_HTML, "utf8");
  // The composition must put expand INSIDE the path handed to q(), so the token
  // survives — concatenating after q() mangles `?t=` into the token and 401s.
  assert.match(page, /api\(`\/api\/runs\$\{[^}]*expandQuery/, "the runs fetch builds its path with expandQuery before q() sees it");
  assert.doesNotMatch(page, /q\((["'`])\/api\/runs\1\)\s*\+/, "never concatenated after q() — that drops the token");
  assert.doesNotMatch(page, /\+\s*[`"']\??expand=/, "never appended as a raw string anywhere");
  assert.match(page, /openProjects\.delete\(p\)[^\n}]*expandedProjects\.delete\(p\)/, "the collapse branch drops the group's expansion");
});
