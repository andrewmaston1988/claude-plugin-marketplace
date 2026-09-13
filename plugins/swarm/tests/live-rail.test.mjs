import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import { SHAPES, GLOSSARY, GLOSSARY_STATES, FAN_OUT, INTERNAL_FANOUT, PLAIN_FOREACH, UNEXPANDED, thirtyCloneDigest, collapsedWave } from "./fixtures/rail-shapes.mjs";

// live.js is a browser static: load it the way tests/live.test.mjs does.
const LIVE_JS = fileURLToPath(new URL("../src/serve/live.js", import.meta.url));
function loadLive() {
  const context = { window: {} };
  vm.createContext(context);
  vm.runInContext(readFileSync(LIVE_JS, "utf8"), context, { filename: "live.js" });
  return context.window.swarmLive;
}
const live = loadLive();
const plain = (v) => JSON.parse(JSON.stringify(v)); // out of the vm realm, for deepEqual

// The colour a line would draw: stateOfGroup over the states of every row it carries.
function colourOf(rows, carries) {
  const states = new Map(rows.map((r) => [r.key, r.states]));
  return live.stateOfGroup(carries.flatMap((k) => (states.get(k) || []).map((state) => ({ state }))));
}

test("railLayout: no line ever runs through a node that is not its own endpoint — every shape (T7)", () => {
  for (const [name, rows] of Object.entries(SHAPES)) {
    const { segments, nodes } = live.railLayout(rows);
    for (const s of segments) {
      if (s.lane0 !== s.lane1) continue; // a step-aside, between rows
      const through = nodes.filter((n) => n.lane === s.lane0 && n.row > s.row0 && n.row < s.row1);
      assert.deepEqual(plain(through), [], `${name}: lane ${s.lane0} rows ${s.row0}..${s.row1} passes a node`);
    }
  }
});

test("railLayout: a fan-out of six costs one extra lane; a clone chain keeps one lane root to sink (T8)", () => {
  assert.equal(live.railLayout(FAN_OUT).maxLane, 1);
  const { lanes } = live.railLayout(GLOSSARY);
  for (const c of [0, 1, 2]) {
    const ls = ["walk", "extend", "verify"].map((l) => lanes.get(`chain-ln[${c}]~${l}`));
    assert.equal(new Set(ls).size, 1, `chain-ln[${c}] stays in one lane: ${ls}`);
  }
});

test("railLayout: a passing line steps aside only at the clone root that needs its lane (T9)", () => {
  const { segments } = live.railLayout(GLOSSARY);
  const steps = segments.filter((s) => s.step);
  const rootRows = new Set(GLOSSARY.filter((r) => r.root).map((r) => r.index));
  assert.ok(steps.length > 0, "enum-pr/enum-gp must move out of chain-ln's clone lane");
  for (const s of steps) assert.ok(rootRows.has(s.row0), `step at row ${s.row0} is not a clone root`);
  const firstRoot = GLOSSARY.find((r) => r.root).index;
  assert.equal(Math.min(...steps.map((s) => s.row0)), firstRoot, "nothing moves before the first clone needs the room");
});

test("railLayout: each clone sink merges back into its trunk, and the trunk then carries it (T10)", () => {
  const { curves, segments, lanes } = live.railLayout(GLOSSARY);
  const trunk = lanes.get("chain-ln");
  for (const c of [0, 1, 2]) {
    const sink = GLOSSARY.find((r) => r.key === `chain-ln[${c}]~verify`);
    const out = curves.find((k) => k.kind === "out" && k.row === sink.index);
    assert.ok(out, `chain-ln[${c}] merges back`);
    assert.equal(out.to, trunk);
    const after = segments.find((s) => s.lane0 === trunk && s.row0 === sink.index && s.off0 === 22);
    assert.ok(after && after.carries.includes(sink.key), `the trunk below chain-ln[${c}] carries its verify`);
  }
});

test("railLayout: trunk colour is the rollup of what it carries (T11)", () => {
  const { segments, lanes } = live.railLayout(GLOSSARY);
  const trunk = lanes.get("chain-ln");
  const label = GLOSSARY.find((r) => r.key === "chain-ln").index;
  const firstMerge = GLOSSARY.find((r) => r.key === "chain-ln[0]~verify").index;
  const above = segments.find((s) => s.lane0 === trunk && s.row0 === label);
  assert.equal(colourOf(GLOSSARY, above.carries), "ok", "above the first merge the trunk carries only enum-ln (done)");
  const below = segments.find((s) => s.lane0 === trunk && s.row0 === firstMerge);
  assert.equal(colourOf(GLOSSARY, below.carries), "run", "a running merged verify turns the trunk purple");
  assert.equal(colourOf(GLOSSARY, ["enum-ln", "chain-pr[0]~walk"]), "warn", "a rate-limited carried row is orange");
  assert.equal(GLOSSARY_STATES["chain-pr[0]~walk"], "rate-limited");
});

test("railLayout: a forEach whose only dependents are its clones still reaches the digest (T12)", () => {
  const rows = live.railRows(thirtyCloneDigest());
  const { segments } = live.railLayout(rows);
  const digest = rows.find((r) => r.key === "__digest");
  assert.deepEqual(plain(digest.parents), ["X"], "the digest waits on the forEach's trunk, reduced");
  assert.ok(segments.some((s) => s.row1 === digest.index && s.off1 === 0 && s.carries.includes("X[29]~verify")), "the trunk lands on the digest carrying the last clone");
});

test("railPitch: 14 / 8 / 5 px by width, and lanes clamp at 24 (T13)", () => {
  assert.equal(live.railPitch(5).laneW, 14);
  assert.equal(live.railPitch(6).laneW, 8);
  assert.equal(live.railPitch(12).laneW, 8);
  assert.equal(live.railPitch(13).laneW, 5);
  const p = live.railPitch(40);
  assert.equal(p.x(30), p.x(23), "surplus lanes share the 24th");
  assert.notEqual(p.x(22), p.x(23));
});

test("railLayout: a clone with internal fan-out/fan-in keeps every edge (T13b)", () => {
  const { landed } = live.railLayout(INTERNAL_FANOUT);
  const pairs = new Set(landed.map(([a, b]) => `${a}>${b}`));
  for (const e of ["X[0]~walk>X[0]~a", "X[0]~walk>X[0]~b", "X[0]~a>X[0]~verify", "X[0]~b>X[0]~verify"]) assert.ok(pairs.has(e), e);
});

test("railRows + railLayout: a digest after every row reclaims lanes — 30 clones stay within 4 lanes (T13c)", () => {
  assert.ok(live.railLayout(live.railRows(thirtyCloneDigest())).maxLane <= 3);
});

test("railLayout: the trunk below a running forEach label carries only its upstream (T13d)", () => {
  const { segments, lanes } = live.railLayout(GLOSSARY);
  const label = GLOSSARY.find((r) => r.key === "chain-ln");
  const seg = segments.find((s) => s.lane0 === lanes.get("chain-ln") && s.row0 === label.index);
  assert.deepEqual(plain(seg.carries), ["enum-ln"], "never the label's own rollup");
});

test("railLayout: a clone root's branch carries the upstream only, never a sibling's merged state (T13e)", () => {
  const { curves } = live.railLayout(GLOSSARY);
  const root1 = GLOSSARY.find((r) => r.key === "chain-ln[1]~walk");
  const branch = curves.find((k) => k.kind === "in" && k.row === root1.index);
  assert.deepEqual(plain(branch.carries), ["enum-ln"]);
  assert.equal(colourOf(GLOSSARY, branch.carries), "ok", "clone 1's branch stays green while clone 0's verify runs");
});

test("railRows: lines into and out of a collapsed wave survive (T13f)", () => {
  const rows = live.railRows(collapsedWave());
  assert.deepEqual(plain(rows.find((r) => r.key === "d").parents), ["wave:1"], "d's parent b is hidden in wave 1");
  assert.deepEqual(plain(rows.find((r) => r.key === "wave:1").parents), ["a"]);
  const pairs = live.railLayout(rows).landed.map(([a, b]) => `${a}>${b}`);
  assert.ok(pairs.includes("a>wave:1") && pairs.includes("wave:1>d"), pairs.join(" "));
});

test("railLayout: an unexpanded container branches off the trunk and merges back like any clone (T13g)", () => {
  const { curves } = live.railLayout(UNEXPANDED);
  const row = UNEXPANDED.find((r) => r.key === "X[1]").index;
  assert.ok(curves.some((k) => k.kind === "in" && k.row === row), "branches in");
  assert.ok(curves.some((k) => k.kind === "out" && k.row === row), "merges back");
});

test("railLayout: a plain forEach's clones are one-row chains off one trunk (T8/T10, plain)", () => {
  const { maxLane, curves } = live.railLayout(PLAIN_FOREACH);
  assert.equal(maxLane, 1);
  assert.equal(curves.filter((k) => k.kind === "out").length, 4);
});
