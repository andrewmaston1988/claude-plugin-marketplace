import { test } from "node:test";
import { equal, deepEqual, ok } from "node:assert/strict";
import { validateRow, aggregate, overall } from "../src/scores.mjs";
import { graded } from "./helpers/perf-rows.mjs";

// The outcome → grades rule, and what an infra outcome does to the aggregate.
// Split out of scores.test.mjs to keep both files under the 500-line bar.

// A whole row, unlike perf-rows' minimal fixture: validateRow reads the model,
// the domain and the grade set, so a rejection names the field it is about.
const row = (over = {}) => ({
  resultsDir: "C:/runs/outcomes-1",
  leaf: "leaf",
  model: "glm-5.2:cloud",
  domain: "godot",
  grades: { adherence: 9, handoff: 6, truthfulness: 8, depth: 7, geometry: 8 },
  outcome: "completed",
  note: "",
  assessedBy: { session: "s" },
  ...over,
});

// quota / rate-limited / harness are infra outcomes: the leaf never got to do
// its job, so it has no output to grade — same rule as a dead session.
for (const outcome of ["failed", "timeout", "session-died", "not-capable", "quota", "rate-limited", "harness"]) {
  test(`validateRow: grades present on ${outcome} are rejected — no output, no grades`, () => {
    const errs = validateRow(row({ outcome, note: "no output" }));
    ok(errs.some((e) => e.startsWith("grades:")), errs.join(" | "));
  });

  test(`validateRow: ${outcome} with no grades and a note passes`, () => {
    const { grades, ...rest } = row();
    deepEqual(validateRow({ ...rest, outcome, note: "the session died on an image read" }), []);
  });
}

// ── infra outcomes stay off the aspect cells ──────────────────────────────────

// A model whose provider ran dry overnight must not read in perf as unreliable.
const infraRow = (leaf, outcome) => graded({ leaf, model: "glm-5.2:cloud", outcome, note: "the provider, not the model", grades: undefined });

test("aggregate: an infra row never lands on an aspect cell — it counts per model instead", () => {
  const rows = [graded({ leaf: "done", model: "glm-5.2:cloud" }), infraRow("q1", "quota"), infraRow("q2", "quota")];
  const report = aggregate(rows, { aspect: "adherence" });
  const cell = report.aspects[0].cells[0];
  equal(cell.n, 1, "only the graded leaf is evidence for the aspect");
  equal(cell.outcomes.quota, 0, "an infra row must not sit in any cell's tally");
  ok(Object.values(cell.outcomes).every(Number.isFinite), "an infra outcome must not put a NaN count on a cell");
  deepEqual(report.infra, [{ model: "glm-5.2:cloud", n: 2 }], "the infra count is on the model, not the cell");
});

test("aggregate: the infra count is per model, never multiplied by the aspect count", () => {
  const rows = [graded({ leaf: "done", model: "glm-5.2:cloud" }), infraRow("q1", "quota"), infraRow("r1", "rate-limited"), infraRow("h1", "harness")];
  deepEqual(aggregate(rows).infra, [{ model: "glm-5.2:cloud", n: 3 }], "eleven aspect cells must not multiply the tally");
});

test("aggregate: the infra count stays with its provider-qualified model", () => {
  const rows = [
    graded({ leaf: "done", model: "glm-5.2:cloud", provider: "ollama" }),
    { ...infraRow("q1", "quota"), provider: "ollama" },
  ];
  deepEqual(aggregate(rows).infra, [{ provider: "ollama", model: "glm-5.2:cloud", n: 1 }]);
});

// The infra pass must not swallow the outcomes that were already counted there:
// a plain failure is still the model's record, so it still lands on the cell.
test("aggregate: a failed row still counts into its model's cells, and is not infra", () => {
  const rows = [
    graded({ leaf: "done", model: "glm-5.2:cloud" }),
    graded({ leaf: "boom", model: "glm-5.2:cloud", outcome: "failed", note: "died on an image read", grades: undefined }),
  ];
  const cell = aggregate(rows, { aspect: "adherence" }).aspects[0].cells[0];
  equal(cell.n, 1, "a failed row is not evidence for the aspect");
  equal(cell.outcomes.failed, 1, "a failed row still shows in the cell's outcome tally");
  deepEqual(aggregate(rows).infra, [], "failed is the model's outcome, never an infra one");
});

test("overall: a model's infra count rides its ranked row", () => {
  const rows = [graded({ leaf: "done", model: "glm-5.2:cloud" }), infraRow("q1", "quota"), infraRow("q2", "quota")];
  const cell = overall(rows).cells.find((c) => c.model === "glm-5.2:cloud");
  equal(cell.infra, 2, "overall must carry the tally, or it shows nowhere on that view");
  equal(cell.n, 1, "the graded row still sets n");
});
