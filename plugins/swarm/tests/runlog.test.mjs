import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, utimesSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { readRun, listRuns, topology, readRunLog } from "../src/runlog.mjs";
const require_runlog = () => ({ readRunLog });
import { RUN_LOG, NOW, buildFixture } from "./fixtures/run-fixture.mjs";

// The manifest snapshot the engine writes at dispatch (effectivePlanDoc shape):
// two finders → a forEach fixer → a child manifest → digest block.
const MANIFEST = {
  resultsDir: "<dir>",
  tasks: [
    { id: "find-a", model: "glm-5.3:cloud", prompt: "…" },
    { id: "find-b", model: "glm-5.3:cloud", prompt: "…" },
    { id: "fix", model: "sonnet", after: ["find-a", "find-b"], forEach: { from: "find-a", path: "sites", maxItems: 30 }, prompt: "…" },
    { id: "review", model: "haiku", after: ["fix"], child: [
      { id: "lint", model: "haiku", prompt: "…" },
      { id: "test", model: "haiku", after: ["lint"], prompt: "…" },
    ] },
    { id: "join", after: ["fix"], compute: "length(deps['fix'])" },
  ],
  digest: { model: "sonnet", instructions: "…" },
};

function withFixture(fn, { manifest = MANIFEST } = {}) {
  const home = mkdtempSync(join(tmpdir(), "swarm-runlog-"));
  const dir = join(home, "runs", "C--code-proj", "fixture-1");
  try {
    buildFixture(dir);
    if (manifest) writeFileSync(join(dir, "manifest.json"), JSON.stringify(manifest), "utf8");
    return fn({ home, dir });
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

test("readRun: every field renderStatus derives, per task, in roster order", () => {
  withFixture(({ dir }) => {
    const run = readRun(dir, { now: NOW, quietWarnMs: 60_000 });
    assert.equal(run.name, "fixture-1");
    assert.equal(run.project, "C--code-proj");
    assert.equal(run.startedMs, Date.parse("2026-09-05T01:00:00Z"));
    assert.equal(run.finishedMs, null, "no summary.json → still running");
    assert.deepEqual(run.tasks.map((t) => t.id), [
      "find-a", "find-b", "fix", "fix[0]", "fix[1]", "review", "review~lint", "review~test", "__digest", "join",
    ]);
    const byId = Object.fromEntries(run.tasks.map((t) => [t.id, t]));
    assert.equal(byId["find-a"].state, "ok");
    assert.equal(byId["find-a"].durationMs, 119000);
    assert.equal(byId["find-a"].tokens.input, 81000);
    assert.equal(byId["find-a"].activity, "Grep registerRoute");
    assert.equal(byId["find-b"].state, "running");
    assert.equal(byId["find-b"].startedMs, Date.parse("2026-09-05T01:00:01Z"));
    assert.equal(byId["find-b"].tokens.input, 220000, "live tick counts");
    assert.equal(byId["find-b"].quietMs, NOW - Date.parse("2026-09-05T01:08:00Z"));
    assert.equal(byId["fix[1]"].state, "rate-limited");
    assert.equal(byId["review~lint"].state, "failed");
    assert.equal(byId["__digest"].state, "pending");
    assert.equal(byId["__digest"].quietMs, null, "quiet only means something for running leaves");
    assert.equal(run.digestPath.endsWith("digest.md"), true);
    assert.equal(run.reportPath, null);
    assert.equal(run.totals.byState.running, 2);
    assert.equal(run.totals.byState.pending, 5, "4 pending in the roster + the agentless join from the manifest");
  });
});

test("readRun: finishedMs from summary.json; missing run.log → null", () => {
  withFixture(({ dir }) => {
    writeFileSync(join(dir, "summary.json"), JSON.stringify({ started: "2026-09-05T01:00:00Z", finished: "2026-09-05T01:09:00Z", tasks: [] }), "utf8");
    assert.equal(readRun(dir, { now: NOW }).finishedMs, Date.parse("2026-09-05T01:09:00Z"));
  });
  assert.equal(readRun(join(tmpdir(), "no-such-swarm-run"), { now: NOW }), null);
});

test("topology: after edges, depth, waves, clone/child/agentless kinds", () => {
  withFixture(({ dir }) => {
    const run = readRun(dir, { now: NOW });
    const byId = Object.fromEntries(run.tasks.map((t) => [t.id, t]));
    assert.deepEqual(byId["fix"].after, ["find-a", "find-b"]);
    assert.equal(byId["fix"].kind, "forEach");
    assert.equal(byId["fix[0]"].kind, "clone");
    assert.equal(byId["fix[0]"].parent, "fix");
    assert.deepEqual(byId["fix[0]"].after, ["find-a", "find-b"], "clones inherit the parent's edges");
    assert.equal(byId["review"].kind, "manifest");
    assert.equal(byId["review~lint"].kind, "child");
    assert.equal(byId["review~lint"].parent, "review");
    assert.deepEqual(byId["review~lint"].after, ["fix"], "a child with no edges of its own waits on what the node waits on");
    assert.deepEqual(byId["review~test"].after, ["review~lint"], "child edges are namespaced");
    assert.equal(byId["__digest"].kind, "digest");
    assert.deepEqual(byId["__digest"].after, run.tasks.filter((t) => t.id !== "__digest").map((t) => t.id), "the digest waits on every other row, clones and children included");
    assert.equal(byId["join"].kind, "agentless");
    assert.equal(byId["join"].state, "pending");
    // depth = longest path from a root
    assert.equal(byId["find-a"].depth, 0);
    assert.equal(byId["fix"].depth, 1);
    assert.equal(byId["fix[0]"].depth, 1);
    assert.equal(byId["review"].depth, 2);
    assert.equal(byId["review~lint"].depth, 2);
    assert.equal(byId["review~test"].depth, 3);
    assert.equal(byId["join"].depth, 2);
    assert.equal(byId["__digest"].depth, 4);
    assert.deepEqual(run.waves[0], ["find-a", "find-b"]);
    assert.deepEqual(run.waves[1], ["fix", "fix[0]", "fix[1]"]);
  });
});

test("topology: agentless nodes from the manifest that never appear in run.log still get a row and a kind", () => {
  const tasks = [{ id: "a", model: "m" }, { id: "b", model: "m" }];
  const t = topology(tasks, { tasks: [{ id: "a", model: "m" }, { id: "b", after: ["a"], compute: "length(deps['a'])" }] });
  assert.equal(t.tasks.find((x) => x.id === "b").kind, "agentless");
  assert.equal(t.tasks.find((x) => x.id === "b").depth, 1);
});

test("topology: a cycle or an unknown edge never hangs — depth caps and the edge is kept", () => {
  const t = topology([{ id: "a" }, { id: "b" }], { tasks: [{ id: "a", after: ["b"] }, { id: "b", after: ["a", "ghost"] }] });
  assert.ok(t.tasks.every((x) => Number.isInteger(x.depth)));
  assert.deepEqual(t.tasks.find((x) => x.id === "b").after, ["a", "ghost"]);
});

test("readRun without a manifest.json still returns tasks, with empty edges and depth 0", () => {
  withFixture(({ dir }) => {
    const run = readRun(dir, { now: NOW });
    assert.deepEqual(run.tasks.find((t) => t.id === "find-a").after, []);
    assert.equal(run.waves.length, 2, "everything at depth 0 except the digest, which always waits on the rest");
    assert.deepEqual(run.waves[1], ["__digest"]);
  }, { manifest: null });
});

test("listRuns: a run whose recorded engine pid is dead is aborted, not active; no pid falls back to recency", () => {
  const home = mkdtempSync(join(tmpdir(), "swarm-runs-pid-"));
  try {
    const mk = (name, firstLine) => {
      const d = join(home, "runs", "C--code-a", name);
      mkdirSync(d, { recursive: true });
      writeFileSync(join(d, "run.log"), firstLine + "\n" + RUN_LOG.split("\n").slice(1).join("\n"), "utf8");
      const t = (NOW - 60_000) / 1000;
      utimesSync(join(d, "run.log"), t, t);
      return d;
    };
    mk("dead-1", '{"ts":"2026-09-05T01:00:00Z","event":"run-start","pid":4242,"tasks":[{"id":"find-a","model":"m"}]}');
    mk("live-1", '{"ts":"2026-09-05T01:00:00Z","event":"run-start","pid":4343,"tasks":[{"id":"find-a","model":"m"}]}');
    mk("nopid-1", '{"ts":"2026-09-05T01:00:00Z","event":"run-start","tasks":[{"id":"find-a","model":"m"}]}');
    const alive = (pid) => (pid == null ? null : pid === 4343);
    const runs = listRuns(home, { now: NOW, recentMs: 30 * 60_000, _alive: alive });
    const by = Object.fromEntries(runs.map((r) => [r.name, r]));
    assert.equal(by["dead-1"].active, false); assert.equal(by["dead-1"].aborted, true);
    assert.equal(by["live-1"].active, true); assert.equal(by["live-1"].aborted, false);
    assert.equal(by["nopid-1"].active, true, "no pid recorded → recency rule");
    assert.equal(readRun(by["dead-1"].dir, { now: NOW }).enginePid, 4242);
    // The run view reads readRun, not listRuns: it must reach the same verdicts.
    const dead = readRun(by["dead-1"].dir, { now: NOW, _alive: alive });
    assert.ok(dead.abortedMs, "dead pid → abortedMs"); assert.equal(dead.staleMs, null);
    const live = readRun(by["live-1"].dir, { now: NOW, _alive: alive });
    assert.equal(live.abortedMs, null); assert.equal(live.staleMs, null);
    const fresh = readRun(by["nopid-1"].dir, { now: NOW, recentMs: 30 * 60_000, _alive: alive });
    assert.equal(fresh.abortedMs, null); assert.equal(fresh.staleMs, null, "no pid, written 60s ago → still live");
    const stale = readRun(by["nopid-1"].dir, { now: NOW, recentMs: 30_000, _alive: alive });
    assert.equal(stale.abortedMs, null); assert.ok(stale.staleMs, "no pid, quiet past recentMs → staleMs");
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test("listRuns: a resumed run is live by its LAST run-start pid, not the reaped engine's at the head", () => {
  // A resume appends a second run-start (the new engine) to the same run.log; the
  // first engine (killed, crashed, reaped) is still on line 1. Reading only the head
  // marked every resumed run aborted and dropped it from the dashboard's live band.
  const home = mkdtempSync(join(tmpdir(), "swarm-runs-resume-"));
  try {
    const d = join(home, "runs", "C--code-a", "resumed-1");
    mkdirSync(d, { recursive: true });
    const body = RUN_LOG.split("\n").slice(1).join("\n");
    const first = '{"ts":"2026-09-05T01:00:00Z","event":"run-start","pid":4242,"tasks":[{"id":"find-a","model":"m"}]}';
    const again = '{"ts":"2026-09-05T02:00:00Z","event":"run-start","pid":4343,"tasks":[{"id":"find-a","model":"m"}]}';
    // Enough events between the two headers that the second is well past the first 4 KiB.
    const filler = Array.from({ length: 80 }, (_, i) => `{"ts":"2026-09-05T01:0${i % 10}:00Z","id":"find-a","event":"activity","activity":"Read file-${i}"}`).join("\n");
    writeFileSync(join(d, "run.log"), [first, body, filler, again, body].join("\n"), "utf8");
    const t = (NOW - 60_000) / 1000;
    utimesSync(join(d, "run.log"), t, t);
    const alive = (pid) => (pid == null ? null : pid === 4343);
    const [run] = listRuns(home, { now: NOW, recentMs: 30 * 60_000, _alive: alive });
    assert.equal(run.aborted, false, "the reaped first engine must not mark the resumed run aborted");
    assert.equal(run.active, true, "the resumed engine is alive and the log is fresh");
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test("readRunLog: a line that parses to null is skipped, not dereferenced", () => {
  const { tasks } = readRun(join(tmpdir(), "no-such"), { now: NOW }) ?? { tasks: null };
  assert.equal(tasks, null);
  const { readRunLog } = require_runlog();
  const r = readRunLog('{"event":"run-start","tasks":["a"]}\nnull\n{"id":"a","state":"ok"}', { now: NOW });
  assert.equal(r.tasks[0].state, "ok");
});

test("listRuns: newest first across projects, active only while run.log is fresh and no summary.json", () => {
  const home = mkdtempSync(join(tmpdir(), "swarm-runs-"));
  try {
    const mk = (proj, run, ageMs, { summary = false, log = true } = {}) => {
      const d = join(home, "runs", proj, run);
      mkdirSync(d, { recursive: true });
      if (log) writeFileSync(join(d, "run.log"), RUN_LOG, "utf8");
      if (summary) writeFileSync(join(d, "summary.json"), "{}", "utf8");
      const t = (NOW - ageMs) / 1000;
      if (log) utimesSync(join(d, "run.log"), t, t);
      return d;
    };
    const live = mk("C--code-a", "live-1", 60_000);
    const stale = mk("C--code-a", "stale-1", 3 * 3600_000);
    const done = mk("C--code-b", "done-1", 30_000, { summary: true });
    mkdirSync(join(home, "runs", "C--code-b", "not-a-run"), { recursive: true });
    writeFileSync(join(home, "runs", "stray.txt"), "x", "utf8");

    const runs = listRuns(home, { now: NOW, recentMs: 30 * 60_000 });
    assert.deepEqual(runs.map((r) => r.dir), [done, live, stale]);
    assert.deepEqual(runs.map((r) => r.active), [false, true, false]);
    assert.equal(runs[1].project, "C--code-a");
    assert.equal(runs[1].name, "live-1");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
