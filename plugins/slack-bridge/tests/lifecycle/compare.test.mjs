// The gate's scoring rules on hand-made outcomes: each measure bites, and anything
// the rules cannot score fails rather than passing as no worse.
import { test } from "node:test";
import assert from "node:assert/strict";
import { regressions } from "./compare.mjs";

const GOOD = { seen: 1, when: "in-turn", first: 1, block: 1, ticking: 0, reachable: true };

test("an outcome equal to its baseline is no worse", () => {
  assert.deepEqual(regressions({ ...GOOD }, { ...GOOD }), []);
});

test("each measure bites when this build drops what the baseline had", () => {
  const cases = [
    [{ seen: 2 }, "the message reaches the session once"],
    [{ when: "after the turn" }, "the message reaches the session as early"],
    [{ first: 0 }, "one block is up while the turn's first tool runs"],
    [{ block: 0 }, "one block is up while the session works on it"],
    [{ ticking: 1 }, "nothing ticks once the turn is over"],
    [{ reachable: false }, "Slack still reaches the idle session"],
  ];
  for (const [patch, measure] of cases) assert.deepEqual(regressions({ ...GOOD, ...patch }, GOOD), [measure], measure);
});

test("a baseline cell that did not run fails instead of scoring everything as no worse", () => {
  assert.deepEqual(regressions(GOOD, { error: "boom" }), ["the baseline cell did not run: boom"]);
});

test("a timing the ranks do not know fails instead of comparing as no worse", () => {
  assert.deepEqual(regressions({ ...GOOD, when: "mid-tool" }, GOOD), ['unknown timing "mid-tool": rank it in WHEN_RANK']);
  assert.deepEqual(regressions(GOOD, { ...GOOD, when: "mid-tool" }), ['unknown timing "mid-tool": rank it in WHEN_RANK']);
});
