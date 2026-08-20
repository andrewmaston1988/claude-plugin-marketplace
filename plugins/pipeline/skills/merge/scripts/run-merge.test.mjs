// run-merge.test.mjs — driver contract, resolution, and decision-table tests.
//
// The driver changes no merge behaviour: it resolves the inputs the merge
// SKILL.md used to resolve by hand, performs the pre-checks, and invokes
// merge.mjs unchanged. These tests pin the port, not the merge.
import { test } from "node:test";
import { equal, deepEqual, ok, match } from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  parseBranches,
  resolvePlansDir,
  chooseModel,
  banner,
  needInput,
  collectSignals,
  stepDone,
  resumeFrom,
  mutexConflict,
  taskLines,
  DRIVER_STEPS,
} from "./run-merge.mjs";

// ── Scenario 2 — branch parsing ───────────────────────────────────────────────
// Step 2 of the old SKILL.md: "Split $ARGUMENTS on whitespace or commas … Each
// entry should already be in autonomous/<slug> form (or <slug> — the runner
// normalises)."

test("parseBranches: comma-separated", () => {
  deepEqual(parseBranches("autonomous/a,autonomous/b"), ["autonomous/a", "autonomous/b"]);
});

test("parseBranches: whitespace-separated", () => {
  deepEqual(parseBranches("autonomous/a autonomous/b"), ["autonomous/a", "autonomous/b"]);
});

test("parseBranches: mixed separators and stray whitespace", () => {
  deepEqual(parseBranches(" a, b  c ,d "), ["a", "b", "c", "d"]);
});

test("parseBranches: empty input is an empty list, not [''] ", () => {
  deepEqual(parseBranches(""), []);
  deepEqual(parseBranches("   "), []);
});

test("parseBranches: de-duplicates — merging a branch twice is never intended", () => {
  deepEqual(parseBranches("a,a,b"), ["a", "b"]);
});

// ── Scenario 2 — plansDir resolution ──────────────────────────────────────────
// Step 2.7: substitute {project}, absolutise against PROJECT_DIR if relative.

test("resolvePlansDir: substitutes the {project} placeholder", () => {
  equal(
    resolvePlansDir("C:/plans/{project}", "myproj", "C:/code/myproj"),
    "C:/plans/myproj",
  );
});

test("resolvePlansDir: absolutises a relative path against PROJECT_DIR", () => {
  equal(resolvePlansDir("plans", "myproj", "C:/code/myproj"), "C:/code/myproj/plans");
});

test("resolvePlansDir: leaves an absolute POSIX path alone", () => {
  equal(resolvePlansDir("/srv/plans", "myproj", "/code/myproj"), "/srv/plans");
});

test("resolvePlansDir: leaves an absolute Windows path alone", () => {
  equal(resolvePlansDir("C:/srv/plans", "myproj", "C:/code/myproj"), "C:/srv/plans");
});

test("resolvePlansDir: unset config yields null, not a bogus path", () => {
  equal(resolvePlansDir("", "myproj", "C:/code/myproj"), null);
  equal(resolvePlansDir(null, "myproj", "C:/code/myproj"), null);
});

// ── Scenario 3 — model decision table, exhaustive ─────────────────────────────
// Step 2.5: "Any of: diverged branch, (needs testing) in plan, dirty stash →
// Sonnet. All clean → Haiku." Eight combinations; the survey names this the row
// most likely to be silently wrong.

const COMBOS = [
  [false, false, false, "haiku"],
  [true, false, false, "sonnet"],
  [false, true, false, "sonnet"],
  [false, false, true, "sonnet"],
  [true, true, false, "sonnet"],
  [true, false, true, "sonnet"],
  [false, true, true, "sonnet"],
  [true, true, true, "sonnet"],
];

for (const [diverged, needsTesting, dirty, expected] of COMBOS) {
  test(`chooseModel: (${diverged},${needsTesting},${dirty}) -> ${expected}`, () => {
    const { model } = chooseModel({ diverged, needsTesting, dirty });
    equal(model, expected);
  });
}

test("chooseModel: never selects opus — the table allows only two tiers", () => {
  for (const [diverged, needsTesting, dirty] of COMBOS) {
    const { model } = chooseModel({ diverged, needsTesting, dirty });
    ok(model === "haiku" || model === "sonnet", `unexpected tier: ${model}`);
  }
});

test("chooseModel: the reason names which boolean fired", () => {
  const { reason } = chooseModel({ diverged: true, needsTesting: false, dirty: false });
  match(reason, /diverged/);
});

test("chooseModel: the clean reason says so", () => {
  const { reason } = chooseModel({ diverged: false, needsTesting: false, dirty: false });
  match(reason, /clean/i);
});

test("chooseModel: names every firing boolean, not just the first", () => {
  const { reason } = chooseModel({ diverged: true, needsTesting: true, dirty: true });
  match(reason, /diverged/);
  match(reason, /needs testing/i);
  match(reason, /dirty/i);
});

// ── Scenario 6 — pause banners carry all three required parts ────────────────
// The driver contract: what to decide, the state needed (including what is
// ABSENT, stated as absent), and a re-run command with every flag resolved.

test("banner: emits the PAUSE marker and the decision", () => {
  const out = banner("Untested items", ["1. Decide"], "node run-merge.mjs --x");
  match(out, /PAUSE: Untested items/);
});

test("banner: includes the literal re-run command", () => {
  const out = banner("X", ["1. Decide"], 'node run-merge.mjs --skip-testing --branches "a"');
  match(out, /node run-merge\.mjs --skip-testing --branches "a"/);
  match(out, /RE-RUN EXACTLY/);
});

test("banner: a pause is never silent — always non-empty output", () => {
  const out = banner("X", [], "cmd");
  ok(out.trim().length > 0);
});

// ── Scenario D1 (borrowed) — the exit-mode contract ──────────────────────────
// Observed live on 2026-08-20: run-workflow.mjs --phase authoring exited 0 with
// zero output, matching none of its four documented outcomes and reading as
// success to any caller branching on them. Pinned here so this driver cannot.

test("needInput: emits one line of parseable JSON", () => {
  const out = needInput("pr", "Which PR number?");
  // The contract is ONE line: a caller reads a single line and parses it. Assert
  // on the raw string before trimming — `.trim().split("\n")` would collapse a
  // pretty-printed payload to one element and pass regardless.
  equal(out.endsWith("\n"), true);
  equal(out.slice(0, -1).includes("\n"), false);
  const parsed = JSON.parse(out);
  equal(parsed.error, "missing_required_field");
  equal(parsed.field, "pr");
});

test("needInput: carries a human-readable hint alongside the field", () => {
  const parsed = JSON.parse(needInput("pr", "Which PR number?").trim());
  ok(String(parsed.hint ?? "").length > 0);
});

// ── Regressions found by running the driver, not by the unit tests ───────────
// Both shipped green units and failed on first contact with a real repo.

test("collectSignals: a nonexistent branch is reported missing, never diverged", () => {
  // Found live: `git merge-base --is-ancestor` exits 128 on an unknown revision,
  // and treating any non-zero as "diverged" silently chose a model for a branch
  // that does not exist.
  const signals = collectSignals("noproj", ["definitely-not-a-branch"], process.cwd(), "HEAD");
  deepEqual(signals.missing, ["definitely-not-a-branch"]);
  equal(signals.diverged, false);
});

test("MERGE_MJS resolves inside the plugin tree, not the merged repo", async () => {
  // Found live: deriving it from projectDir pointed at
  // <target-repo>/plugins/pipeline/... which exists only in this repo.
  const { readFileSync } = await import("node:fs");
  const src = readFileSync(new URL("./run-merge.mjs", import.meta.url), "utf8");
  ok(
    src.includes('new URL("./merge.mjs", import.meta.url)'),
    "merge.mjs must resolve via import.meta.url",
  );
  ok(
    !src.includes('join(projectDir, "plugins/pipeline'),
    "merge.mjs must not be derived from projectDir",
  );
});

// ── Scenario 7 — resume guards key on reality, never on the marker ★ ─────────
// The single most important behaviour in this driver. A guard that reads the
// progress marker instead of the world produces a silently wrong resume: the
// marker says pending, the side effect already landed, and the re-run does it
// twice. These prove each guard consults the world.

test("stepDone: squash guard reads git ancestry, not the marker", () => {
  // merged=true means the branch is already an ancestor of the target: the
  // squash landed, whatever the marker claims.
  equal(stepDone("squash", { merged: true, planMoved: false, marker: "pending" }), true);
  equal(stepDone("squash", { merged: false, planMoved: false, marker: "completed" }), false);
});

test("stepDone: plan-move guard reads the complete/ dir, not the marker", () => {
  equal(stepDone("move-plans", { merged: true, planMoved: true, marker: "pending" }), true);
  equal(stepDone("move-plans", { merged: true, planMoved: false, marker: "completed" }), false);
});

test("stepDone: an unknown step is never assumed done", () => {
  equal(stepDone("no-such-step", { merged: true, planMoved: true, marker: "completed" }), false);
});

test("resumeFrom: picks the first step the world says is incomplete", () => {
  // Squash landed, plan move did not — the classic half-completed merge.
  equal(resumeFrom({ merged: true, planMoved: false }), "move-plans");
});

test("resumeFrom: nothing done yet resumes at the squash", () => {
  equal(resumeFrom({ merged: false, planMoved: false }), "squash");
});

test("resumeFrom: everything done resumes at nothing", () => {
  equal(resumeFrom({ merged: true, planMoved: true }), null);
});

// ── Scenario 8 — mutex on a foreign subject ──────────────────────────────────

test("mutexConflict: a progress entry for other branches blocks the run", () => {
  const c = mutexConflict({ existingSubject: "autonomous/other", requested: "autonomous/mine" });
  equal(c, true);
});

test("mutexConflict: the same subject is a resume, not a conflict", () => {
  equal(mutexConflict({ existingSubject: "autonomous/mine", requested: "autonomous/mine" }), false);
});

test("mutexConflict: no existing entry is never a conflict", () => {
  equal(mutexConflict({ existingSubject: null, requested: "autonomous/mine" }), false);
});

// ── Scenario 10 — [TASK_*] lines ─────────────────────────────────────────────

test("taskLines: one TASK_CREATE per step on init", () => {
  const out = taskLines("create", DRIVER_STEPS);
  const created = out.trim().split("\n").filter((l) => l.startsWith("[TASK_CREATE]"));
  equal(created.length, DRIVER_STEPS.length);
});

test("taskLines: an update names the index and the status", () => {
  const out = taskLines("update", DRIVER_STEPS, { index: 2, status: "completed" });
  match(out, /\[TASK_UPDATE\] 2 completed/);
});

// Found by I2, not by the unit tests: `merge-base --is-ancestor` is blind to a
// squash merge — the squash rewrites the commits, so the branch never becomes an
// ancestor. Checking ancestry alone reported a landed merge as pending, and the
// resume would have squashed it a second time. observeWorld now falls back to
// `git cherry`, whose "-" prefix means already-applied-upstream.
test("observeWorld: detects a landed SQUASH merge, not just a fast-forward", () => {
  const src = readFileSync(new URL("./run-merge.mjs", import.meta.url), "utf8");
  ok(src.includes('"cherry"'), "must probe git cherry, not ancestry alone");
  ok(
    src.indexOf('"cherry"') > src.indexOf('"--is-ancestor"'),
    "ancestry first (cheap), cherry as the squash-aware fallback",
  );
});
