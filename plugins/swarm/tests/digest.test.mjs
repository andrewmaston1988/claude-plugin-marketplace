import { test } from "node:test";
import { equal, deepEqual, ok } from "node:assert/strict";
import { join } from "node:path";
import { buildDigestTask, scratchPath, DIGEST_ID } from "../src/digest.mjs";
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

test("report mode mandates the ledger but leaves the body free", () => {
  const p = buildDigestTask(reportPlan()).prompt;
  ok(/PROVEN \/ OPEN ledger/.test(p), "ledger is spine");
  ok(/body/i.test(p) && /shape it to|the document a human/i.test(p),
    "the body's shape must be left to the model");
});

// The report is about its SUBJECT, not the run. Operator, 2026-07-14, after the
// first live reports read like autopsies of the swarm run.
test("report mode: no leaf-accounting SECTION, no process narration", () => {
  const p = buildDigestTask(reportPlan()).prompt;
  // NB: the DIGEST compression rules still say "- Leaf accounting: account for
  // every leaf" — correct, digest.md accounts for leaves. The REPORT must not
  // mandate a "## Leaf accounting" SECTION heading.
  ok(!/## Leaf accounting/.test(p), "the report must NOT mandate a ## Leaf accounting section");
  ok(/never name a leaf, a model, a token count, or a verifier verdict/i.test(p),
    "the report must be told not to narrate the run");
  ok(/about its subject|not about this run/i.test(p), "the subject-not-run rule is stated");
});

// The engine no longer prepends a title — the leaf writes its own, and the engine
// appends only a one-line run footnote. This reverses PR #186.
test("report mode: the leaf writes its OWN title; engine appends a footnote", () => {
  const p = buildDigestTask(reportPlan()).prompt;
  ok(/write your own title/i.test(p), "the leaf must be told to write its own title");
  ok(/appends a (one-line )?run footnote|footnote at the (very )?bottom/i.test(p),
    "the leaf must be told the engine only APPENDS a footnote");
  ok(!/engine prepends|do not write a title/i.test(p),
    "the old 'do not write a title, engine prepends' instruction must be gone");
});

// Two claims-you-cannot-cash the live reports made: calling scaffolding 'rot', and
// widening a plan's scope. Both are the report over-reaching its evidence.
test("report mode: scaffolding-vs-rot and scope-preservation", () => {
  const p = buildDigestTask(reportPlan()).prompt;
  ok(/scaffolding is not rot|scaffolding/i.test(p) && /named,? (and )?live plan sub-phase|plan sub-phase/i.test(p),
    "must teach scaffolding-vs-rot (a field awaiting a named sub-phase is not dead)");
  ok(/the comment, not the field|flag the comment/i.test(p), "the defect is usually the comment");
  ok(/preserve scope|carry its scope|widen/i.test(p), "must teach scope-preservation");
});

// The HTML renderer's marker vocabulary — optional, semantic, things the model
// already writes. Gives the model flex without imposing a layout.
test("report mode: documents the optional HTML marker vocabulary", () => {
  const p = buildDigestTask(reportPlan()).prompt;
  ok(/badge/i.test(p) && /PROVEN.*OPEN.*REFUTED/s.test(p), "verdict-badge markers named");
  ok(/operator-feel, unresolved/i.test(p) && /chip/i.test(p), "the playtest-call chip named");
  ok(/path:line/i.test(p) && /citation span/i.test(p), "the citation-span marker named");
  ok(/optional|instead of inventing/i.test(p), "the markers are OPTIONAL, not a template");
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
  ok(/nothing to say|padded/i.test(p), "no empty sections");
  ok(/one job|restate the ledger/i.test(p),
    "each part does one job — the body must not re-state the ledger");
  ok(/encode|order actually mean/i.test(p),
    "structure must encode something true, not decorate");
});

// A report worth reading is not composed in one pass. The leaf gets a NAMED
// drafting directory (naming it is the whole mechanism — the leaf writes where it
// is told) and an explicit draft → re-read → cut cycle before it commits.
test("report mode: names a scratch dir and demands a revise pass", () => {
  const p = buildDigestTask(reportPlan()).prompt;
  ok(p.includes(scratchPath("C:/work/.swarm/run-1")), "the drafting directory must be named");
  ok(/draft/i.test(p) && /re-read|read your own draft/i.test(p),
    "must demand a draft and a re-read, not one-pass composition");
  ok(/cut/i.test(p), "the last move is to cut");
  ok(/checklist/i.test(p), "the revise pass needs something to interrogate the draft against");
});

// The scratch dir is a drafting affordance, not part of the contract — a
// non-report digest is read-only and has nothing to draft.
test("no report block — no scratch dir is offered", () => {
  ok(!buildDigestTask(plan()).prompt.includes("scratch-__digest"));
});

// Coverage caveats moved from a leaf-accounting section into the BODY, as a
// subject-level statement: say what is not covered, never which component failed.
test("report mode: incomplete coverage is stated plainly in the body", () => {
  const p = buildDigestTask(reportPlan()).prompt;
  ok(/coverage is incomplete|what is NOT covered|not covered/i.test(p),
    "must tell the leaf to state coverage gaps");
  ok(/say plainly/i.test(p), "plainly — not hedged");
  ok(/never which component failed/i.test(p),
    "coverage gaps are subject-level, not 'the verify leaf died'");
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
