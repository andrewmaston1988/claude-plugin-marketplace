import { test } from "node:test";
import { equal, deepEqual, ok } from "node:assert/strict";
import { join } from "node:path";
import { buildDigestTask, DIGEST_ID } from "../src/digest.mjs";
import { resultPath } from "../src/results.mjs";

const plan = (over = {}) => ({
  cwd: "C:/work",
  resultsDir: "C:/work/.swarm/run-1",
  goal: "find every caller of frobnicate",
  tasks: [
    { id: "scan-a", model: "glm-4.6:cloud", timeoutMs: 600000 },
    { id: "scan-b", model: "glm-4.6:cloud", timeoutMs: 900000 },
    { id: "join", model: "haiku", timeoutMs: 600000 },
  ],
  digest: { model: "minimax-m3:cloud", instructions: "must_be_sure: the panel auth path" },
  ...over,
});

test("digest task depends on ALL leaves and uses the plan's digest model", () => {
  const t = buildDigestTask(plan());
  equal(t.id, DIGEST_ID);
  deepEqual(t.after, ["scan-a", "scan-b", "join"]);
  equal(t.model, "minimax-m3:cloud");
  equal(t.cwd, "C:/work");
  equal(t.isDigest, true);
  equal(t.timeoutMs, 900000); // widest leaf timeout
});

// A verifier fed a truncated finding-set checked only a PREFIX. Without this the
// digest promotes the unchecked remainder as if a verifier had confirmed it —
// which is how a fabricated finding reached the operator on p5-review round 5.
test("digest is told to treat a truncated leaf input as unverified", () => {
  const t = buildDigestTask(plan());
  ok(t.prompt.includes("promptTruncations"), "digest must know the field name to look for");
  ok(/prefix/i.test(t.prompt), "digest must be told the leaf saw only a prefix");
  ok(/OPEN/.test(t.prompt) && /never PROVEN|not PROVEN/i.test(t.prompt),
    "digest must be told such findings are OPEN, never PROVEN");
});

test("digest leaf is read-only — the ENGINE writes digest.md", () => {
  const t = buildDigestTask(plan());
  equal(t.allowedTools, "Read");
  ok(t.prompt.includes("Do not write any files"));
  ok(t.prompt.includes("the engine writes digest.md"));
});

// ── report mode ───────────────────────────────────────────────────────────────

const reportPlan = (report = true) => plan({ digest: { model: "haiku", report } });

test("report mode arms Write and names the report path", () => {
  const t = buildDigestTask(reportPlan());
  equal(t.allowedTools, "Read,Write");
  ok(t.prompt.includes(join("C:/work/.swarm/run-1", "report.md")), "must name the absolute report path");
});

test("report mode orders the two phases: expand into report.md, THEN compress", () => {
  const p = buildDigestTask(reportPlan()).prompt;
  const writeAt = p.indexOf("report.md");
  const returnAt = p.lastIndexOf("Return the digest");
  ok(writeAt > -1 && returnAt > writeAt, "the report phase must come before the digest return");
  ok(/compress/i.test(p), "phase 2 must still be a compression");
});

test("report mode mandates the spine but leaves the body free", () => {
  const p = buildDigestTask(reportPlan()).prompt;
  ok(/PROVEN \/ OPEN ledger/.test(p), "ledger is spine");
  ok(/account for every leaf/i.test(p), "leaf accounting is spine");
  ok(/do not write.*header|engine prepends|the engine writes the header/i.test(p),
    "the leaf must be told NOT to write the provenance header — the engine prepends it");
  ok(/body/i.test(p) && /shape it to|the document a human/i.test(p),
    "the body's shape must be left to the model");
});

// Telling a model "be original" does nothing; it reaches for the default anyway.
// Naming the default is what lets it recognise itself producing one. (Lifted from
// frontend-design, which names the three looks AI visual design always lands on.)
test("report mode names the generic report shape so the model can avoid it", () => {
  const p = buildDigestTask(reportPlan()).prompt;
  ok(/Executive Summary/i.test(p), "the default shape must be named, not just warned against");
  ok(/Key Findings/i.test(p) && /Recommendations/i.test(p), p.slice(0, 200));
  ok(/regardless of|every run|any run/i.test(p),
    "must say the default appears regardless of what the run actually was");
});

test("report mode: structure must encode something true, and each part does one job", () => {
  const p = buildDigestTask(reportPlan()).prompt;
  ok(/nothing to say|no section/i.test(p), "no empty sections");
  ok(/one job|does not restate|must not restate/i.test(p),
    "each part does one job — the body must not re-state the ledger");
  ok(/encode|carries? (real )?information|order carries/i.test(p),
    "structure must encode something true, not decorate");
});

// "Errors don't apologize, and they are never vague about what happened."
test("report mode: a failed or empty leaf gets a plain statement, not a hedge", () => {
  const p = buildDigestTask(reportPlan()).prompt;
  ok(/failed|empty/i.test(p), p.slice(0, 120));
  ok(/hedge|vague|apolog/i.test(p), "must forbid hedging about what happened");
});

// summary.json is written AFTER the graph drains; the digest is a node IN the
// graph. Naming it would point the leaf at a file that cannot exist yet.
test("the prompt never names summary.json", () => {
  ok(!buildDigestTask(reportPlan()).prompt.includes("summary.json"));
  ok(!buildDigestTask(plan()).prompt.includes("summary.json"));
});

test("report string form steers the body verbatim; true form adds no steer", () => {
  const steered = buildDigestTask(reportPlan("Lead with the security findings."));
  ok(steered.prompt.includes("Lead with the security findings."));
  ok(!buildDigestTask(reportPlan(true)).prompt.includes("Lead with"));
});

// Regression pin: report mode is OPT-IN. A run without it must be byte-identical
// to the pre-feature digest — the agent path is load-bearing and must not drift.
test("no report block — the leaf stays read-only and hears nothing about a report", () => {
  const t = buildDigestTask(plan());
  equal(t.allowedTools, "Read");
  ok(!/report\.md/.test(t.prompt), "a non-report run must never mention report.md");
});

test("template contains goal, every result path, and the compression markers", () => {
  const p = plan();
  const t = buildDigestTask(p);
  ok(t.prompt.includes("find every caller of frobnicate"));
  for (const leaf of p.tasks) {
    ok(t.prompt.includes(resultPath(p.resultsDir, leaf.id)), `missing path for ${leaf.id}`);
  }
  ok(t.prompt.includes("PROVEN / OPEN ledger"));
  ok(t.prompt.includes("Drill-down"));
  ok(t.prompt.includes("headlines first"));
  ok(t.prompt.includes("must_be_sure"));
  ok(t.prompt.toLowerCase().includes("account for every leaf"));
});

// The old rule capped every leaf at 5 bullets, silently discarding a sixth real
// finding. The cap is a rule now, not a number.
test("bullets are governed by findings, not an arbitrary cap", () => {
  const p = buildDigestTask(plan()).prompt;
  ok(!p.includes("≤5"), "the hardcoded 5-bullet cap must be gone");
  ok(/one bullet per|per real finding/i.test(p), "bullets must track real findings");
  ok(/no padding|do not pad/i.test(p), "and must not be padded to fill");
});

test("manifest digest.instructions are appended verbatim", () => {
  const t = buildDigestTask(plan());
  ok(t.prompt.includes("must_be_sure: the panel auth path"));
  const noInstr = buildDigestTask(plan({ digest: { model: "haiku" } }));
  ok(!noInstr.prompt.includes("Additional instructions"));
});

test("missing goal falls back to an explicit placeholder", () => {
  const t = buildDigestTask(plan({ goal: "" }));
  ok(t.prompt.includes("(no goal line provided in the manifest)"));
});
