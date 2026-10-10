// Coverage rendering: the loud-not-fatal closing-block lines a leaf's read
// shortfall earns, and the projection a grade row copies.
import { test } from "node:test";
import { equal, deepEqual, ok } from "node:assert/strict";
import { formatClosing, mechanicalOf } from "../src/results.mjs";

// A coverage shortfall is the third loud-not-fatal line, same register as a
// refuted citation: the leaf kept its output, the reader is told how much it read.
test("formatClosing renders a loud coverage-gap line, kept-not-failed", () => {
  const out = formatClosing({
    summaryPath: "S/summary.json", digestPath: "d",
    coverageGaps: [{ id: "rv-arch", status: "incomplete", required: 5, read: 2, missed: ["a.mjs:1-40", "b.mjs:1-90", "c.mjs", "d.mjs"] }],
  });
  ok(out.includes("rv-arch"), out);
  ok(out.includes("read 2 of 5 required — 4 missed (4 ranges)"), out);
  ok(/a\.mjs:1-40/.test(out) && /\+1 more/.test(out), "first 3 missed + overflow count: " + out);
  ok(!/failed|deleted/i.test(out), "a shortfall never reads as a failed leaf: " + out);
});

test("formatClosing renders item and range coverage counts and zero-engagement failure", () => {
  const out = formatClosing({
    summaryPath: "S/summary.json", digestPath: "d",
    coverageGaps: [
      { id: "rv-partial", status: "incomplete", required: 32, read: 1, missedItems: 31, missed: Array(47).fill("a.mjs:1-2"), uncoverable: ["big.mjs:4"] },
      { id: "rv-empty", status: "incomplete", required: 3, read: 0, missedItems: 3, missed: [], coverageFailed: true },
    ],
  });
  ok(out.includes("read 1 of 32 required — 31 missed (47 ranges)"), out);
  ok(out.includes("uncoverable 1"), out);
  ok(out.includes("engaged with none of its 3 required inputs"), out);
});

// An unparseable transcript is the ENGINE failing to read the leaf's output, not
// the leaf idling — it must not be rendered as "read 0 of N", which blames the leaf.
test("formatClosing separates an unparseable transcript from a leaf that read nothing", () => {
  const out = formatClosing({
    summaryPath: "S/summary.json", digestPath: "d",
    coverageGaps: [{ id: "rv-cx", status: "unparseable", required: 4, read: 0, missed: ["a.mjs", "b.mjs"] }],
  });
  ok(out.includes("rv-cx"), out);
  ok(/transcript could not be parsed/i.test(out), out);
  ok(!out.includes("read 0 of 4 required"), out);
});

// mechanicalOf is a projection a grade row copies — coverage must ride along so
// `swarm grade --init` rows carry it; a resultless value is null, never dropped.
test("mechanicalOf carries coverage, null when absent", () => {
  const cov = { status: "incomplete", required: 5, read: 2, missed: ["a.mjs:1-40"] };
  deepEqual(mechanicalOf({ ok: true, coverage: cov }).coverage, cov);
  equal(mechanicalOf({ ok: true }).coverage, null);
});
