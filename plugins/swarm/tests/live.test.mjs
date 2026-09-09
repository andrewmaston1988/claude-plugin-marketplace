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

test("coalesce: a burst of requests arms one scheduled run, and the latch resets after it fires (L10)", () => {
  const { coalesce } = loadLive();
  const scheduled = [];
  const request = coalesce((fn) => scheduled.push(fn));
  let ran = 0;
  request(() => ran++);
  request(() => ran++);
  request(() => ran++);
  assert.equal(scheduled.length, 1, "three requests, one scheduled run");
  assert.equal(ran, 0, "nothing runs until the scheduler fires");
  scheduled.pop()();
  assert.equal(ran, 1, "exactly one route ran");
  request(() => ran++);
  assert.equal(scheduled.length, 1, "the latch reset — a later burst schedules again");
  scheduled.pop()();
  assert.equal(ran, 2);
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
test("page wiring: the runs fetch splices expandQuery inside q()'s argument, and collapse drops the expansion (T6/T7)", () => {
  const page = readFileSync(PAGE_HTML, "utf8");
  // The composition must put expand INSIDE the path handed to q(), so the token
  // survives — concatenating after q() mangles `?t=` into the token and 401s.
  assert.match(page, /api\(`\/api\/runs\$\{[^}]*expandQuery/, "the runs fetch builds its path with expandQuery before q() sees it");
  assert.doesNotMatch(page, /q\((["'`])\/api\/runs\1\)\s*\+/, "never concatenated after q() — that drops the token");
  assert.doesNotMatch(page, /\+\s*[`"']\??expand=/, "never appended as a raw string anywhere");
  assert.match(page, /openProjects\.delete\(p\)[^\n}]*expandedProjects\.delete\(p\)/, "the collapse branch drops the group's expansion");
});
