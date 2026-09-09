import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, utimesSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import http from "node:http";
import { createServer, safeSegment } from "../src/serve/server.mjs";
import { RUN_LOG, NOW, buildFixture } from "./fixtures/run-fixture.mjs";
import { touchHeartbeat, heartbeatPath } from "../src/results.mjs";
import { listRuns as realListRuns, projectKeys as realProjectKeys } from "../src/runlog.mjs";

const cfg = (over = {}) => ({ quietWarnSecs: 60, dashboard: { port: 0, bind: "127.0.0.1", token: null, ...over } });

function seedHome() {
  const home = mkdtempSync(join(tmpdir(), "swarm-serve-"));
  const live = join(home, "runs", "C--code-a", "live-1");
  buildFixture(live);
  // find-b carries a prompt but NO result file: the in-flight case, where the prompt is
  // only knowable from this snapshot. `join` is agentless — no prompt, and must stay 404.
  writeFileSync(join(live, "manifest.json"), JSON.stringify({ tasks: [{ id: "find-a", model: "m", prompt: "authored a" }, { id: "find-b", model: "m", prompt: "authored b" }, { id: "fix", model: "m", after: ["find-a"] }, { id: "review", model: "m", after: ["fix"] }, { id: "join", compute: "1" }], digest: { model: "m", instructions: "steer the digest" } }), "utf8");
  writeFileSync(join(live, "results", "find-a.json"), JSON.stringify({ id: "find-a", model: "m", ok: true, output: "ten bullets", tokens: { input: 1, output: 2 }, numTurns: 7, prompt: "secret prompt" }), "utf8");
  writeFileSync(join(live, "results", "find-a.log"), "raw stream json — never served", "utf8");
  const done = join(home, "runs", "C--code-b", "done-1");
  buildFixture(done);
  writeFileSync(join(done, "summary.json"), JSON.stringify({ started: "2026-09-05T00:00:00Z", finished: "2026-09-05T00:30:00Z", tasks: [] }), "utf8");
  writeFileSync(join(done, "report.md"), "# Report\n\nPROVEN — a claim", "utf8");
  // Both logs get explicit stamps: the live one 5 s before NOW, the finished one an
  // hour earlier — otherwise the finished fixture carries the real clock and sorts first.
  const t = (NOW - 5000) / 1000;
  utimesSync(join(live, "run.log"), t, t);
  touchHeartbeat(live, new Date(NOW - 5000).toISOString(), process.pid);
  utimesSync(heartbeatPath(live), t, t);
  const td = (NOW - 3600_000) / 1000;
  utimesSync(join(done, "run.log"), td, td);
  return { home, live, done };
}

async function withServer(opts, fn) {
  const { home } = opts;
  const watchers = [];
  const _watch = (path, listener) => { const w = { path, listener, closed: false, close() { this.closed = true; } }; watchers.push(w); return w; };
  // _pollMs defaults slow: only the poll tests opt into a fast tick, so no other
  // test's frame counting can be perturbed by a liveness broadcast landing mid-window.
  const server = createServer({ home, cfg: opts.cfg || cfg(), now: () => opts.now ?? NOW, _watch, _heartbeatMs: opts.heartbeatMs ?? 60_000, _debounceMs: 30, _pollMs: opts.pollMs ?? 60_000, ...(opts.seams || {}) });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const port = server.address().port;
  const get = (path, { raw = false } = {}) => new Promise((resolve, reject) => {
    http.get({ host: "127.0.0.1", port, path }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (c) => { body += c; });
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: raw ? body : tryJson(body) }));
    }).on("error", reject);
  });
  try { return await fn({ get, port, watchers, server, home }); } finally { server.closeAllConnections(); await new Promise((r) => server.close(r)); }
}
const tryJson = (s) => { try { return JSON.parse(s); } catch { return s; } };

test("safeSegment: ids with [ ] ~ . - pass; traversal, slashes, empties do not", () => {
  for (const ok of ["find-a", "fix[0]", "review~lint", "C--code-a", "run.1", "__digest"]) assert.ok(safeSegment(ok), ok);
  for (const bad of ["..", "../x", "a/b", "a\\b", "", ".", "a b", "%2e%2e", "C:"]) assert.ok(!safeSegment(bad), JSON.stringify(bad));
});

test("routes: runs list, run, leaf (no raw log; prompt exposed for the accordion), digest fallback, manifest", async () => {
  const { home } = seedHome();
  try {
    await withServer({ home }, async ({ get }) => {
      const runs = await get("/api/runs");
      assert.equal(runs.status, 200);
      assert.deepEqual(runs.body.runs.map((r) => [r.project, r.name, r.active]), [["C--code-a", "live-1", true], ["C--code-b", "done-1", false]]);
      assert.equal(runs.body.runs[0].byState.running, 2, "list rows carry the state counts");
      assert.equal(typeof runs.body.runs[0].startedMs, "number", "the page's per-project live-row sort needs startedMs on every row");

      const run = await get("/api/runs/C--code-a/live-1");
      assert.equal(run.status, 200);
      assert.equal(run.body.name, "live-1");
      assert.ok(Array.isArray(run.body.waves));
      assert.equal(run.body.quietWarnMs, 60_000);
      assert.equal(run.body.tasks.find((t) => t.id === "fix").depth, 1);

      const leaf = await get("/api/runs/C--code-a/live-1/leaves/find-a");
      assert.equal(leaf.status, 200);
      assert.equal(leaf.body.output, "ten bullets");
      assert.equal(leaf.body.numTurns, 7);
      // Reversal of a deliberate earlier guard ("the prompt stays on disk"), on the
      // operator's explicit call (2026-09-05) so the leaf view can show what the leaf
      // was actually asked. Note the surface this widens: the dashboard binds 0.0.0.0
      // and `dashboard.token` is null by default, so any host that can reach the port
      // can now read prompts as well as outputs. Pinned so the exposure stays
      // intentional and a future reader sees it was chosen, not leaked.
      assert.equal(leaf.body.prompt, "secret prompt", "the prompt is served for the leaf-view accordion");
      assert.equal(leaf.body.log, undefined);
      assert.equal((await get("/api/runs/C--code-a/live-1/leaves/nope")).status, 404);

      const digest = await get("/api/runs/C--code-a/live-1/digest", { raw: true });
      assert.equal(digest.status, 200);
      assert.match(digest.headers["content-type"], /text\/html/);
      assert.match(digest.body, /digest/);
      const report = await get("/api/runs/C--code-b/done-1/digest", { raw: true });
      assert.match(report.body, /Report/, "report.md wins over digest.md");
      rmSync(join(home, "runs", "C--code-b", "done-1", "report.md"));
      rmSync(join(home, "runs", "C--code-b", "done-1", "digest.md"));
      assert.equal((await get("/api/runs/C--code-b/done-1/digest")).status, 404);

      const manifest = await get("/manifest.webmanifest");
      assert.equal(manifest.status, 200);
      assert.equal(manifest.body.display, "standalone");
      assert.ok(manifest.body.icons.some((i) => i.sizes === "512x512" && i.type === "image/png"), "a 512 PNG for Android");
      const page = await get("/", { raw: true });
      assert.equal(page.status, 200);
      assert.match(page.body, /rel="apple-touch-icon"[^>]*icon-180\.png/, "iOS home-screen icon linked");
      assert.match(page.body, /id="rail"/, "the rail overlay is in the page");
      assert.equal((await get("/icon-999.png")).status, 404);
      assert.equal((await get("/api/runs/C--code-a/nope")).status, 404);
    });
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test("runs list is per project: a busy project cannot crowd a quiet one off the estate", async () => {
  const { home } = seedHome();
  try {
    for (let i = 0; i < 12; i++) {
      const d = join(home, "runs", "C--code-busy", `old-${i}`);
      buildFixture(d);
      writeFileSync(join(d, "summary.json"), JSON.stringify({ finished: "2026-09-04T00:00:00Z", tasks: [] }), "utf8");
      const t = (NOW - 3600_000 * (i + 2)) / 1000;
      utimesSync(join(d, "run.log"), t, t);
    }
    await withServer({ home }, async ({ get }) => {
      const { body } = await get("/api/runs");
      const busy = body.runs.filter((r) => r.project === "C--code-busy");
      assert.equal(busy.length, 8, "capped per project");
      assert.ok(body.runs.some((r) => r.project === "C--code-b"), "the quiet project's finished run still listed");
      assert.ok(body.runs.some((r) => r.project === "C--code-a" && r.active), "live run always listed");
    });
  } finally { rmSync(home, { recursive: true, force: true }); }
});

// ── per-group finished cap ──────────────────────────────────────────────────
// The cap counts DISPLAY GROUPS — a repo plus its worktree keys are one group —
// and finishedTotals must report what exists on disk, not what was sent.
function seedFinished(home, project, name, ageHours) {
  const d = join(home, "runs", project, name);
  buildFixture(d);
  writeFileSync(join(d, "summary.json"), JSON.stringify({ started: "2026-09-05T00:00:00Z", finished: "2026-09-05T00:30:00Z", tasks: [] }), "utf8");
  const t = (NOW - ageHours * 3600_000) / 1000;
  utimesSync(join(d, "run.log"), t, t);
}

function seedActive(home, project, name) {
  const d = join(home, "runs", project, name);
  buildFixture(d);
  const t = (NOW - 5000) / 1000;
  utimesSync(join(d, "run.log"), t, t);
  touchHeartbeat(d, new Date(NOW - 5000).toISOString(), process.pid);
  utimesSync(heartbeatPath(d), t, t);
}

// One display group spread over three raw keys: the plain repo plus two worktrees.
function seedFooGroup(home) {
  for (let i = 0; i < 5; i++) seedFinished(home, "C--code-foo", `fin-${i}`, i + 1);
  for (let i = 0; i < 3; i++) seedFinished(home, "C--code-.worktrees-foo-branch-a", `wt-a-${i}`, 10 + i);
  for (let i = 0; i < 3; i++) seedFinished(home, "C--code-.worktrees-foo-branch-b", `wt-b-${i}`, 20 + i);
}

test("the finished cap counts groups, not raw keys: 3 rows across foo + its two worktree keys", async () => {
  const home = mkdtempSync(join(tmpdir(), "swarm-cap-group-"));
  try {
    seedFooGroup(home);
    await withServer({ home, cfg: cfg({ finishedPerProject: 3 }) }, async ({ get }) => {
      const { body } = await get("/api/runs");
      const finished = body.runs.filter((r) => !r.active);
      assert.equal(finished.length, 3, `per-group cap keeps 3 finished rows total, got ${finished.length}`);
      assert.ok(finished.every((r) => r.group === "C--code-foo"), "every kept row is grouped under the repo, not its worktree key");
      // A cap that kept the newest three of the first key it happened to see would pass
      // the count and still be wrong — the kept rows must be newest across ALL keys.
      assert.deepEqual(finished.map((r) => r.mtimeMs), [1, 2, 3].map((h) => NOW - h * 3600_000), "the kept three are the three newest across all three keys");
    });
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test("active runs are never capped, wherever they sit in the group", async () => {
  const home = mkdtempSync(join(tmpdir(), "swarm-cap-live-"));
  try {
    seedFooGroup(home);
    for (const p of ["C--code-foo", "C--code-.worktrees-foo-branch-a", "C--code-.worktrees-foo-branch-b"]) {
      seedActive(home, p, "live-a");
      seedActive(home, p, "live-b");
    }
    await withServer({ home, cfg: cfg({ finishedPerProject: 3 }) }, async ({ get }) => {
      const { body } = await get("/api/runs");
      const active = body.runs.filter((r) => r.active);
      assert.equal(active.length, 6, "all six active runs appear — the cap applies to finished rows only");
    });
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test("finishedTotals reports what exists on disk, not what was sent", async () => {
  const home = mkdtempSync(join(tmpdir(), "swarm-cap-total-"));
  try {
    seedFooGroup(home);
    await withServer({ home, cfg: cfg({ finishedPerProject: 3 }) }, async ({ get }) => {
      const { body } = await get("/api/runs");
      assert.equal(body.finishedTotals["C--code-foo"], 11, "11 finished runs on disk, 3 rows sent");
      assert.equal(body.finishedTotals["C--code-.worktrees-foo-branch-a"], undefined, "totals are keyed by display group, not raw worktree key");
    });
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test("groupLabel is derived over every raw key — a fully-finished sibling still anchors the common prefix", async () => {
  const home = mkdtempSync(join(tmpdir(), "swarm-cap-prefix-"));
  try {
    seedActive(home, "C--code-alpha", "live-1");
    for (let i = 0; i < 5; i++) seedFinished(home, "C--code-beta", `fin-${i}`, i + 1);
    await withServer({ home, cfg: cfg({ finishedPerProject: 3 }) }, async ({ get }) => {
      const { body } = await get("/api/runs");
      const alpha = body.runs.find((r) => r.project === "C--code-alpha");
      assert.equal(alpha.groupLabel, "alpha", "the common prefix is C--code- only while both C--code-* keys are in the derivation");
    });
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test("the single-run payload carries groupLabel so a deep-linked header shows the short name", async () => {
  const home = mkdtempSync(join(tmpdir(), "swarm-cap-deep-"));
  try {
    seedFinished(home, "C--code-foo", "fin-0", 1);
    seedFinished(home, "C--code-.worktrees-foo-branch-a", "wt-a-0", 2);
    seedFinished(home, "C--code-bar", "fin-0", 3);
    await withServer({ home }, async ({ get }) => {
      const run = await get("/api/runs/C--code-.worktrees-foo-branch-a/wt-a-0");
      assert.equal(run.status, 200);
      assert.equal(run.body.groupLabel, "foo", "a worktree key's label is its repo's, not the raw key");
    });
  } finally { rmSync(home, { recursive: true, force: true }); }
});

// ── expand: opt-in per-group uncapping ─────────────────────────────────────
// The failure mode is a fixture too small to tell capped from uncapped: every
// fixture here carries more finished runs than the cap, in more than one project.
function seedExpandFixture(home) {
  for (let i = 0; i < 12; i++) seedFinished(home, "C--code-alpha", `fin-${i}`, i + 1);
  for (let i = 0; i < 9; i++) seedFinished(home, "C--code-beta", `fin-${i}`, i + 1);
}

const finishedByGroup = (body) => {
  const out = {};
  for (const r of body.runs) if (!r.active) out[r.group] = (out[r.group] || 0) + 1;
  return out;
};

test("expand: the named group returns uncapped, and only that group (T1)", async () => {
  const home = mkdtempSync(join(tmpdir(), "swarm-expand-"));
  try {
    seedExpandFixture(home);
    await withServer({ home, cfg: cfg({ finishedPerProject: 3 }) }, async ({ get }) => {
      assert.deepEqual(finishedByGroup((await get("/api/runs")).body), { "C--code-alpha": 3, "C--code-beta": 3 }, "no expand: both groups capped");
      const counts = finishedByGroup((await get("/api/runs?expand=C--code-alpha")).body);
      assert.equal(counts["C--code-alpha"], 12, "alpha uncapped: all 12 finished rows");
      // Asserting only alpha's count would also pass an implementation that lifts
      // the cap globally — beta is the half that catches it.
      assert.equal(counts["C--code-beta"], 3, "beta still capped");
    });
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test("expand: an expanded group never consumes another group's allowance (T2)", async () => {
  const home = mkdtempSync(join(tmpdir(), "swarm-expand-allowance-"));
  try {
    seedExpandFixture(home);
    await withServer({ home, cfg: cfg({ finishedPerProject: 3 }) }, async ({ get }) => {
      const body = (await get("/api/runs?expand=C--code-alpha")).body;
      // The expansion must actually have happened — against a handler that ignores
      // `expand` entirely, beta's 3 passes while alpha is still capped.
      assert.equal(body.runs.filter((r) => !r.active && r.group === "C--code-alpha").length, 12, "alpha uncapped");
      const beta = body.runs.filter((r) => !r.active && r.group === "C--code-beta");
      // Exact 3, never >= 1: an expanded row that still bumped a shared counter is
      // the starvation the skip must prevent.
      assert.equal(beta.length, 3, `beta keeps exactly its 3-row allowance, got ${beta.length}`);
      assert.deepEqual(beta.map((r) => r.mtimeMs), [1, 2, 3].map((h) => NOW - h * 3600_000), "and they are beta's newest three, not a leftover slice");
    });
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test("finishedTotals is untouched by expand — the header stays honest in both states (T3)", async () => {
  const home = mkdtempSync(join(tmpdir(), "swarm-expand-totals-"));
  try {
    seedExpandFixture(home);
    await withServer({ home, cfg: cfg({ finishedPerProject: 3 }) }, async ({ get }) => {
      const base = await get("/api/runs");
      assert.equal(base.body.finishedTotals["C--code-alpha"], 12);
      assert.equal(base.body.finishedTotals["C--code-beta"], 9);
      const expanded = await get("/api/runs?expand=C--code-alpha");
      assert.equal(expanded.body.finishedTotals["C--code-alpha"], 12, "the total counts the disk, not the rows sent");
      assert.equal(expanded.body.finishedTotals["C--code-beta"], 9);
    });
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test("expand: unknown, empty and malformed values are ignored, never fatal (T4)", async () => {
  const home = mkdtempSync(join(tmpdir(), "swarm-expand-malformed-"));
  try {
    seedExpandFixture(home);
    await withServer({ home, cfg: cfg({ finishedPerProject: 3 }) }, async ({ get }) => {
      for (const suffix of ["?expand=does-not-exist", "?expand=", "?expand=../../etc"]) {
        const r = await get(`/api/runs${suffix}`);
        assert.equal(r.status, 200, suffix);
        assert.deepEqual(finishedByGroup(r.body), { "C--code-alpha": 3, "C--code-beta": 3 }, `${suffix} returns the normal capped payload — the value must never reach a path join`);
      }
    });
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test("path safety: every traversal shape is a 404 and never leaves the runs root", async () => {
  const { home } = seedHome();
  writeFileSync(join(home, "outside.json"), "{\"leak\":true}", "utf8");
  try {
    await withServer({ home }, async ({ get }) => {
      for (const p of [
        "/api/runs/../outside.json",
        "/api/runs/..%2F..%2Foutside.json",
        "/api/runs/C--code-a/..%2F..%2Foutside.json",
        "/api/runs/C--code-a/live-1/leaves/..%2F..%2F..%2Foutside",
        "/api/runs/C--code-a/live-1/leaves/%2e%2e",
        "/api/runs/C--code-a/live-1/leaves/a%5Cb",
        "/api/runs/C%3A/x",
      ]) {
        const r = await get(p);
        assert.equal(r.status, 404, p);
        assert.ok(!/leak/.test(JSON.stringify(r.body)), p);
      }
    });
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test("token: when configured, every route needs ?t=; 401 without, 200 with", async () => {
  const { home } = seedHome();
  try {
    await withServer({ home, cfg: cfg({ token: "s3cret" }) }, async ({ get }) => {
      assert.equal((await get("/api/runs")).status, 401);
      assert.equal((await get("/manifest.webmanifest")).status, 401);
      assert.equal((await get("/api/runs?t=wrong")).status, 401);
      assert.equal((await get("/api/runs?t=s3cret")).status, 200);
    });
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test("events: SSE emits one debounced run event per burst, names the run, and heartbeats", async () => {
  const { home, live } = seedHome();
  try {
    await withServer({ home, heartbeatMs: 40 }, async ({ get, port, watchers }) => {
      const frames = [];
      const req = http.get({ host: "127.0.0.1", port, path: "/events" }, (res) => {
        assert.match(res.headers["content-type"], /text\/event-stream/);
        res.setEncoding("utf8");
        res.on("data", (c) => frames.push(c));
      });
      await new Promise((r) => setTimeout(r, 60));
      const logWatcher = watchers.find((w) => w.path === join(live, "run.log"));
      assert.ok(logWatcher, "the active run's run.log is watched");
      logWatcher.listener("change", "run.log");
      logWatcher.listener("change", "run.log");
      await new Promise((r) => setTimeout(r, 120));
      req.destroy();
      const text = frames.join("");
      const runEvents = text.split("\n\n").filter((f) => /^event: run$/m.test(f));
      assert.equal(runEvents.length, 1, `one debounced event, got:\n${text}`);
      assert.match(runEvents[0], /"project":"C--code-a"/);
      assert.match(runEvents[0], /"name":"live-1"/);
      assert.match(text, /^: ping/m, "heartbeat comment present");
    });
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test("leaf route: an in-flight leaf serves its authored prompt from the manifest, not a 404", async () => {
  // results/<id>.json only appears when a leaf finishes, so before this the leaf view had
  // nothing to show for a running leaf — which is exactly when you want to know what it
  // was asked. An agentless node has no prompt and must still 404.
  const { home } = seedHome();
  try {
    await withServer({ home }, async ({ get }) => {
      const inflight = await get("/api/runs/C--code-a/live-1/leaves/find-b");
      assert.equal(inflight.status, 200, "an in-flight leaf is served, not 404'd");
      assert.equal(inflight.body.prompt, "authored b");
      assert.equal(inflight.body.authored, true, "flagged authored — placeholders are unsubstituted");

      const finished = await get("/api/runs/C--code-a/live-1/leaves/find-a");
      assert.equal(finished.body.prompt, "secret prompt", "a finished leaf keeps the dispatched prompt");
      assert.equal(finished.body.authored, undefined, "not the authored fallback");

      // __digest lives in the manifest's `digest` block, not in tasks — without a case
      // for it, the run's most-watched node is the one that stays 404 while in flight.
      const digest = await get("/api/runs/C--code-a/live-1/leaves/__digest");
      assert.equal(digest.status, 200, "an in-flight digest is served too");
      assert.equal(digest.body.prompt, "steer the digest");
      assert.equal(digest.body.authored, true);

      assert.equal((await get("/api/runs/C--code-a/live-1/leaves/join")).status, 404, "agentless node has no prompt");
      assert.equal((await get("/api/runs/C--code-a/live-1/leaves/nope")).status, 404, "unknown id still 404s");
    });
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test("events: the poll reports a run that FINISHED, with no filesystem event at all", async () => {
  // summary.json lands in a path nothing watches (only run.log is watched), and an
  // engine dying is not an fs event in the first place. So the clock is the only
  // signal for either. Deliberately fires NO watcher listener: doing so would route
  // through onRootOrProject, which broadcasts unconditionally, and the unfixed code
  // would pass while asserting nothing.
  const { home, live } = seedHome();
  try {
    await withServer({ home, pollMs: 40 }, async ({ port }) => {
      const frames = [];
      const req = http.get({ host: "127.0.0.1", port, path: "/events" }, (res) => {
        res.setEncoding("utf8");
        res.on("data", (c) => frames.push(c));
      });
      await new Promise((r) => setTimeout(r, 60));
      frames.length = 0; // drop the connect frame and any first-tick noise
      writeFileSync(join(live, "summary.json"), JSON.stringify({ started: "2026-09-05T00:00:00Z", finished: "2026-09-05T00:30:00Z", tasks: [] }), "utf8");
      await new Promise((r) => setTimeout(r, 160));
      req.destroy();
      const runsEvents = frames.join("").split("\n\n").filter((f) => /^event: runs$/m.test(f));
      assert.ok(runsEvents.length >= 1, `the poll must announce the finish; got:\n${frames.join("")}`);
    });
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test("events: the poll picks up a NEW run when no watcher fires — a dead handle cannot hide it", async () => {
  // The arrival half of the same fault: refreshWatchers is otherwise only reachable
  // from the watchers' own events, so once a handle goes quiet nothing rebuilds it.
  // No listener is fired here — that is the point.
  const { home } = seedHome();
  try {
    await withServer({ home, pollMs: 40 }, async ({ port, watchers }) => {
      const frames = [];
      const req = http.get({ host: "127.0.0.1", port, path: "/events" }, (res) => {
        res.setEncoding("utf8");
        res.on("data", (c) => frames.push(c));
      });
      await new Promise((r) => setTimeout(r, 60));
      frames.length = 0;
      const fresh = join(home, "runs", "C--code-a", "live-2");
      buildFixture(fresh);
      const t = (NOW - 1000) / 1000;
      utimesSync(join(fresh, "run.log"), t, t);
      touchHeartbeat(fresh, new Date(NOW - 1000).toISOString(), process.pid);
      utimesSync(heartbeatPath(fresh), t, t);
      await new Promise((r) => setTimeout(r, 160));
      req.destroy();
      const runsEvents = frames.join("").split("\n\n").filter((f) => /^event: runs$/m.test(f));
      assert.ok(runsEvents.length >= 1, `the poll must announce the new run; got:\n${frames.join("")}`);
      assert.ok(watchers.some((w) => w.path === join(fresh, "run.log")), "the poll also starts watching it");
    });
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test("events: a root change refreshes watchers so a new run gets watched", async () => {
  const { home } = seedHome();
  try {
    await withServer({ home }, async ({ port, watchers }) => {
      const req = http.get({ host: "127.0.0.1", port, path: "/events" }, (res) => { res.on("data", () => {}); });
      await new Promise((r) => setTimeout(r, 60));
      const fresh = join(home, "runs", "C--code-a", "live-2");
      buildFixture(fresh);
      const t = (NOW - 1000) / 1000;
      utimesSync(join(fresh, "run.log"), t, t);
      touchHeartbeat(fresh, new Date(NOW - 1000).toISOString(), process.pid);
      utimesSync(heartbeatPath(fresh), t, t);
      const root = watchers.find((w) => w.path === join(home, "runs"));
      assert.ok(root, "runs root watched");
      // fs.watch is not recursive: a new run under an EXISTING project is only seen
      // by that project dir's watcher, so one must exist.
      const proj = watchers.find((w) => w.path === join(home, "runs", "C--code-a"));
      assert.ok(proj, "each project dir is watched");
      proj.listener("rename", "live-2");
      await new Promise((r) => setTimeout(r, 80));
      assert.ok(watchers.some((w) => w.path === join(fresh, "run.log")), "new active run is watched after a project-dir event");
      req.destroy();
    });
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test("icons: PNGs are real PNGs at the declared sizes, cached, and drawn (not a flat square)", async () => {
  const { home } = seedHome();
  try {
    await withServer({ home }, async ({ port }) => {
      for (const size of [180, 192, 512]) {
        const buf = await new Promise((resolve, reject) => {
          http.get({ host: "127.0.0.1", port, path: `/icon-${size}.png` }, (res) => {
            assert.equal(res.statusCode, 200); assert.equal(res.headers["content-type"], "image/png");
            const chunks = []; res.on("data", (c) => chunks.push(c)); res.on("end", () => resolve(Buffer.concat(chunks)));
          }).on("error", reject);
        });
        assert.deepEqual([...buf.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], "PNG signature");
        assert.equal(buf.readUInt32BE(16), size, "IHDR width");
        assert.equal(buf.readUInt32BE(20), size, "IHDR height");
        assert.ok(buf.length > 500 && buf.length < 60_000, `plausible size for ${size}: ${buf.length}`);
      }
    });
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test("perf: the score store ranked as scores.mjs ranks it — overall + every aspect, re-read when the file changes, bad aspect is a 400", async () => {
  const { home } = seedHome();
  try {
    const row = (leaf, model, grades, outcome = "completed") => JSON.stringify({ ts: "2026-09-05T00:00:00Z", resultsDir: "/r/x-1", leaf, model, effort: null, domain: "node", grades: { adherence: null, handoff: null, truthfulness: null, depth: null, discrimination: null, code: null, impl: null, search: null, web: null, vision: null, geometry: null, ...grades }, outcome, note: "", assessedBy: { session: "t" } });
    const path = join(home, "model-scores.jsonl");
    writeFileSync(path, [row("a", "m-good", { adherence: 9, handoff: 9, truthfulness: 9, depth: 9, code: 8 }), row("b", "m-thin", { adherence: 4, handoff: 5, truthfulness: 4, depth: 5 }), row("c", "m-thin", {}, "session-died")].join("\n") + "\n", "utf8");
    const { readRows, overall, aggregate } = await import("../src/scores.mjs");
    await withServer({ home, cfg: { ...cfg(), grading: { enabled: true } } }, async ({ get }) => {
      const p = await get("/api/perf");
      assert.equal(p.status, 200);
      assert.deepEqual(p.body.overall, overall(readRows(path)).cells, "overall is scores.mjs's ranking, untouched");
      assert.deepEqual(p.body.report, aggregate(readRows(path)).aspects, "every aspect table rides along");
      assert.equal(p.body.overall[0].model, "m-good");
      assert.deepEqual(p.body.domains, ["node"]);
      assert.equal(p.body.rows, 3);
      const one = await get("/api/perf?aspect=code&domain=node");
      assert.equal(one.body.report.length, 1); assert.equal(one.body.report[0].aspect, "code");
      assert.deepEqual(one.body.filters, { aspect: "code", model: null, domain: "node" });
      const m = await get("/api/perf?model=m-thin");
      assert.equal(m.body.overall.length, 1); assert.equal(m.body.overall[0].outcomes["session-died"], 1);
      assert.equal((await get("/api/perf?aspect=vibes")).status, 400);
      // A grade lands: the store's mtime moves and the next request sees the row.
      writeFileSync(path, readFileSync(path, "utf8") + row("d", "m-new", { adherence: 7, handoff: 7, truthfulness: 7, depth: 7 }) + "\n", "utf8");
      const t = (NOW + 60_000) / 1000; utimesSync(path, t, t);
      assert.equal((await get("/api/perf")).body.overall.length, 3);
    });
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test("grading flag: /api/runs and /api/perf carry grading.enabled — false by default, true when the config says so", async () => {
  const { home } = seedHome();
  try {
    await withServer({ home }, async ({ get }) => {
      assert.equal((await get("/api/runs")).body.grading, false);
      const off = (await get("/api/perf")).body;
      assert.equal(off.grading, false);
      assert.equal(off.overall, undefined, "off serves no ranking");
      assert.equal(off.report, undefined, "off serves no aspect table");
      assert.equal(off.views, undefined, "off serves no views either");
    });
    await withServer({ home, cfg: { ...cfg(), grading: { enabled: true } } }, async ({ get }) => {
      assert.equal((await get("/api/runs")).body.grading, true);
      const on = (await get("/api/perf")).body;
      assert.equal(on.grading, true);
      assert.ok(Array.isArray(on.overall), "on serves the ranking");
      assert.ok(on.views, "on serves the three perf-views read-models");
      assert.ok(Array.isArray(on.views.coverage.cells));
      assert.ok(Array.isArray(on.views.reliability));
      assert.ok(Array.isArray(on.views.leaders));
    });
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("/perf.js: served as text/javascript, no-store, token-gated like everything else", async () => {
  const { home } = seedHome();
  try {
    await withServer({ home }, async ({ get }) => {
      const r = await get("/perf.js", { raw: true });
      assert.equal(r.status, 200);
      assert.match(r.headers["content-type"], /text\/javascript/);
      assert.equal(r.headers["cache-control"], "no-store");
      assert.match(r.body, /window\.perfViews/);
    });
    await withServer({ home, cfg: cfg({ token: "s3cret" }) }, async ({ get }) => {
      assert.equal((await get("/perf.js")).status, 401);
      assert.equal((await get("/perf.js?t=s3cret")).status, 200);
    });
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test("/live.js: served, and its body defines window.swarmLive (S1)", async () => {
  const { home } = seedHome();
  try {
    await withServer({ home }, async ({ get }) => {
      const r = await get("/live.js", { raw: true });
      assert.equal(r.status, 200);
      assert.match(r.body, /window\.swarmLive/);
    });
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test("/live.js: token-gated — 401 without ?t= (S2)", async () => {
  const { home } = seedHome();
  try {
    await withServer({ home, cfg: cfg({ token: "s3cret" }) }, async ({ get }) => {
      assert.equal((await get("/live.js")).status, 401);
    });
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test("/api/runs: carries clockMs and uiPollMs, defaulting to 1000/5000 and reflecting config (S3)", async () => {
  const { home } = seedHome();
  try {
    await withServer({ home }, async ({ get }) => {
      const r = await get("/api/runs");
      assert.equal(r.body.clockMs, 1000);
      assert.equal(r.body.uiPollMs, 5000);
    });
    await withServer({ home, cfg: cfg({ clockMs: 2000, uiPollMs: 9000 }) }, async ({ get }) => {
      const r = await get("/api/runs");
      assert.equal(r.body.clockMs, 2000);
      assert.equal(r.body.uiPollMs, 9000);
    });
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test("a superseded-summary run reads as live over HTTP — active on the list, finishedMs null on detail (S4)", async () => {
  const { home } = seedHome();
  try {
    const d = join(home, "runs", "C--code-a", "resumed-2");
    mkdirSync(d, { recursive: true });
    const first = '{"ts":"2026-09-05T01:00:00Z","event":"run-start","pid":1111,"tasks":[{"id":"find-a","model":"m"}]}';
    const firstOk = '{"ts":"2026-09-05T01:01:00Z","id":"find-a","state":"ok","durationMs":60000}';
    const second = `{"ts":"2026-09-05T01:05:30Z","event":"run-start","pid":${process.pid},"tasks":[{"id":"find-a","model":"m"}]}`;
    writeFileSync(join(d, "run.log"), [first, firstOk, second].join("\n"), "utf8");
    writeFileSync(join(d, "summary.json"), JSON.stringify({ started: "2026-09-05T01:00:00Z", finished: "2026-09-05T01:05:00Z", tasks: [] }), "utf8");
    const summaryT = Date.parse("2026-09-05T01:05:00Z") / 1000;
    utimesSync(join(d, "summary.json"), summaryT, summaryT);
    const logT = Date.parse("2026-09-05T01:06:00Z") / 1000; // the resumed engine kept appending after the summary
    utimesSync(join(d, "run.log"), logT, logT);
    touchHeartbeat(d, "2026-09-05T01:09:30Z", process.pid);
    utimesSync(heartbeatPath(d), Date.parse("2026-09-05T01:09:30Z") / 1000, Date.parse("2026-09-05T01:09:30Z") / 1000);

    const now = Date.parse("2026-09-05T01:10:00Z");
    await withServer({ home, now }, async ({ get }) => {
      const list = await get("/api/runs");
      const row = list.body.runs.find((r) => r.project === "C--code-a" && r.name === "resumed-2");
      assert.ok(row, "the resumed run is on the list");
      assert.equal(row.active, true);

      const detail = await get("/api/runs/C--code-a/resumed-2");
      assert.equal(detail.status, 200);
      assert.equal(detail.body.finishedMs, null, "readRun's payload carries no active field; finishedMs is what it has");
      assert.equal(detail.body.active, undefined);
    });
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test("perf: a model-filtered request carries the model's overall rank among every model in the domain", async () => {
  const { home } = seedHome();
  try {
    const row = (leaf, model, grades) => JSON.stringify({ ts: "2026-09-05T00:00:00Z", resultsDir: "/r/x-1", leaf, model, effort: null, domain: "node", grades: { adherence: null, handoff: null, truthfulness: null, depth: null, discrimination: null, code: null, impl: null, search: null, web: null, vision: null, geometry: null, ...grades }, outcome: "completed", note: "", assessedBy: { session: "t" } });
    const g = (v) => ({ adherence: v, handoff: v, truthfulness: v, depth: v });
    const lines = [];
    for (let i = 0; i < 6; i++) { lines.push(row(`a${i}`, "top", g(9))); lines.push(row(`b${i}`, "mid", g(7))); lines.push(row(`c${i}`, "low", g(4))); }
    writeFileSync(join(home, "model-scores.jsonl"), lines.join("\n") + "\n");
    await withServer({ home, cfg: { ...cfg(), grading: { enabled: true } } }, async ({ get }) => {
      const mid = (await get("/api/perf?model=mid")).body;
      assert.deepEqual(mid.rank, { position: 2, of: 3 });
      const all = (await get("/api/perf")).body;
      assert.equal(all.rank, undefined, "no model filter → no rank");
    });
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// A resumed run. Two run-start lines; readRunLog clears per-leaf state on each,
// so everything after the SECOND is the current attempt. Every leaf here has a
// result file on disk written during the first attempt — the whole point is that
// its presence says nothing about which attempt produced it.
const RESUMED_LOG = [
  '{"ts":"2026-09-05T00:50:00Z","event":"run-start","pid":null,"tasks":[{"id":"stale","model":"m"},{"id":"cached","model":"m"},{"id":"settled","model":"m"},{"id":"silent","model":"m"}]}',
  '{"ts":"2026-09-05T00:51:00Z","id":"stale","state":"failed","durationMs":1000}',
  '{"ts":"2026-09-05T00:51:00Z","id":"cached","state":"ok","durationMs":1000}',
  '{"ts":"2026-09-05T00:51:00Z","id":"settled","state":"ok","durationMs":1000}',
  '{"ts":"2026-09-05T00:51:00Z","id":"silent","state":"ok","durationMs":1000}',
  // --- resume: everything above is a previous attempt ---
  '{"ts":"2026-09-05T01:00:00Z","event":"run-start","pid":null,"tasks":[{"id":"stale","model":"m"},{"id":"cached","model":"m"},{"id":"settled","model":"m"},{"id":"silent","model":"m"}]}',
  '{"ts":"2026-09-05T01:00:01Z","id":"stale","state":"running"}',
  // `cached` is what a resume writes for a leaf it did not re-run — scheduler.mjs record(t, "skipped", …)
  '{"ts":"2026-09-05T01:00:01Z","id":"cached","state":"skipped","durationMs":1000}',
  '{"ts":"2026-09-05T01:00:01Z","id":"settled","state":"running"}',
  '{"ts":"2026-09-05T01:02:00Z","id":"settled","state":"ok","durationMs":119000}',
  // `silent` gets no event at all after the resume — readRunLog defaults it to pending
].join("\n");

const RESUMED_MANIFEST = {
  tasks: [
    { id: "stale", model: "m", prompt: "authored stale" },
    { id: "cached", model: "m", prompt: "authored cached" },
    { id: "settled", model: "m", prompt: "authored settled" },
    { id: "silent", model: "m", prompt: "authored silent" },
  ],
};

function seedResumed() {
  const home = mkdtempSync(join(tmpdir(), "swarm-resumed-"));
  const dir = join(home, "runs", "C--code-a", "resumed-1");
  mkdirSync(join(dir, "results"), { recursive: true });
  writeFileSync(join(dir, "run.log"), RESUMED_LOG, "utf8");
  writeFileSync(join(dir, "manifest.json"), JSON.stringify(RESUMED_MANIFEST), "utf8");
  // The real shape observed on disk for a leaf that died during worktree setup:
  // no `prompt` key at all, because none was recorded before it failed.
  writeFileSync(join(dir, "results", "stale.json"), JSON.stringify({ id: "stale", model: "m", ok: false, exit: 1, durationMs: 1000, output: "worktree setup failed: git worktree add failed" }), "utf8");
  writeFileSync(join(dir, "results", "cached.json"), JSON.stringify({ id: "cached", model: "m", ok: true, output: "cached output", prompt: "p", tokens: { input: 1, output: 2 } }), "utf8");
  writeFileSync(join(dir, "results", "settled.json"), JSON.stringify({ id: "settled", model: "m", ok: true, exit: 0, output: "fresh output", prompt: "p", tokens: { input: 1, output: 2 } }), "utf8");
  writeFileSync(join(dir, "results", "silent.json"), JSON.stringify({ id: "silent", model: "m", ok: true, output: "previous attempt output", prompt: "p" }), "utf8");
  return { home, dir };
}

test("R1/R2: an unsettled leaf's result is a previous attempt's — serve the authored prompt", async () => {
  const { home } = seedResumed();
  try {
    await withServer({ home }, async ({ get }) => {
      const r = await get("/api/runs/C--code-a/resumed-1/leaves/stale");
      assert.equal(r.status, 200);
      // R1 — the dead attempt must not reach the client at all
      assert.equal(r.body.authored, true);
      assert.equal(r.body.output, undefined, "stale output must not be served");
      assert.equal(r.body.ok, undefined, "stale ok:false must not render a failure badge");
      // R2 — that result carries no `prompt` key, so the prompt row can only come from the manifest
      assert.equal(r.body.prompt, "authored stale");
    });
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test("G4: a leaf with no events in the current attempt is unsettled, not finished", async () => {
  const { home } = seedResumed();
  try {
    await withServer({ home }, async ({ get }) => {
      const r = await get("/api/runs/C--code-a/resumed-1/leaves/silent");
      assert.equal(r.body.authored, true, "readRunLog defaults an unmentioned leaf to pending");
      assert.equal(r.body.output, undefined);
      assert.equal(r.body.prompt, "authored silent");
    });
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test("G1/G2: a settled leaf's result is served — including a resume-cached `skipped` one", async () => {
  const { home } = seedResumed();
  try {
    await withServer({ home }, async ({ get }) => {
      // G1 — settled in THIS attempt
      const settled = await get("/api/runs/C--code-a/resumed-1/leaves/settled");
      assert.equal(settled.body.authored, undefined);
      assert.equal(settled.body.output, "fresh output");
      assert.equal(settled.body.ok, true);
      // G2 — every already-ok leaf on every resumed run takes this path; treating
      // `skipped` as unsettled would blank the majority of a resumed run's results.
      const cached = await get("/api/runs/C--code-a/resumed-1/leaves/cached");
      assert.equal(cached.body.authored, undefined);
      assert.equal(cached.body.output, "cached output");
    });
  } finally { rmSync(home, { recursive: true, force: true }); }
});

// A forEach expansion that CONTRACTS on resume: attempt 1 minted three clones, attempt 2
// minted two. Clones are never in manifest.tasks — they join the roster only via the
// `expand` event — so topology() cannot backfill a row for the dropped one, and its state
// reads back as undefined rather than any roster state.
const CONTRACTED_LOG = [
  '{"ts":"2026-09-05T00:50:00Z","event":"run-start","pid":null,"tasks":[{"id":"fix","model":"m"}]}',
  '{"ts":"2026-09-05T00:50:01Z","event":"expand","id":"fix","model":"m","clones":3}',
  '{"ts":"2026-09-05T00:51:00Z","id":"fix[0]","state":"ok","durationMs":1000}',
  '{"ts":"2026-09-05T00:51:00Z","id":"fix[1]","state":"ok","durationMs":1000}',
  '{"ts":"2026-09-05T00:51:00Z","id":"fix[2]","state":"ok","durationMs":1000}',
  // --- resume: the upstream now yields two items, so only two clones are minted ---
  '{"ts":"2026-09-05T01:00:00Z","event":"run-start","pid":null,"tasks":[{"id":"fix","model":"m"}]}',
  '{"ts":"2026-09-05T01:00:01Z","event":"expand","id":"fix","model":"m","clones":2}',
  '{"ts":"2026-09-05T01:00:02Z","id":"fix[0]","state":"ok","durationMs":1000}',
  '{"ts":"2026-09-05T01:00:02Z","id":"fix[1]","state":"running"}',
].join("\n");

test("D1: a clone dropped by a contracted expansion has no roster row — its result is a previous attempt's", async () => {
  const home = mkdtempSync(join(tmpdir(), "swarm-contracted-"));
  const dir = join(home, "runs", "C--code-a", "contracted-1");
  mkdirSync(join(dir, "results"), { recursive: true });
  writeFileSync(join(dir, "run.log"), CONTRACTED_LOG, "utf8");
  writeFileSync(join(dir, "manifest.json"), JSON.stringify({ tasks: [{ id: "fix", model: "m", prompt: "authored fix", forEach: { from: "src", path: "", maxItems: 10 } }] }), "utf8");
  writeFileSync(join(dir, "results", "fix[2].json"), JSON.stringify({ id: "fix[2]", model: "m", ok: true, output: "attempt-1 output", prompt: "p" }), "utf8");
  writeFileSync(join(dir, "results", "fix[0].json"), JSON.stringify({ id: "fix[0]", model: "m", ok: true, output: "current output", prompt: "p" }), "utf8");
  try {
    await withServer({ home }, async ({ get }) => {
      const dropped = await get("/api/runs/C--code-a/contracted-1/leaves/fix%5B2%5D");
      assert.equal(dropped.body.authored, true, "no row in this attempt's roster ⇒ the file is a previous attempt's");
      assert.equal(dropped.body.output, undefined, "attempt-1 output must not be served as current");
      assert.equal(dropped.body.prompt, "authored fix", "the clone falls back to its parent's authored prompt");
      // The guard: a clone that DID run this attempt is unaffected.
      const kept = await get("/api/runs/C--code-a/contracted-1/leaves/fix%5B0%5D");
      assert.equal(kept.body.authored, undefined);
      assert.equal(kept.body.output, "current output");
    });
  } finally { rmSync(home, { recursive: true, force: true }); }
});

// The single-run payload once called listRuns just to derive one group label  a
// full estate scan (stat + liveness per run) on every run/node/leaf fetch, including
// the 5 s poll, where it had been O(1). Counting the calls is the only assertion that
// bites: the payload shape is identical either way.
test("single-run payload derives its label from project keys, never a full estate scan", async () => {
  const { home } = seedHome();
  let listRunsCalls = 0, keyCalls = 0;
  const seams = {
    _listRuns: (...a) => { listRunsCalls++; return realListRuns(...a); },
    _projectKeys: (...a) => { keyCalls++; return realProjectKeys(...a); },
  };
  try {
    await withServer({ home, seams }, async ({ get }) => {
      listRunsCalls = 0; keyCalls = 0;               // ignore anything the boot did
      const r = await get("/api/runs/C--code-a/live-1");
      assert.equal(r.status, 200);
      assert.equal(r.body.groupLabel, "a");          // still labelled correctly
      assert.equal(listRunsCalls, 0);                // RED before the fix: this was 1
      assert.equal(keyCalls, 1);
    });
  } finally { rmSync(home, { recursive: true, force: true }); }
});
