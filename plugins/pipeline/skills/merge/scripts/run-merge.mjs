#!/usr/bin/env node
/**
 * run-merge.mjs — driver for the /merge skill.
 *
 * The SKILL.md called itself "a thin wrapper" and then carried six blocks of
 * shell (Steps 1–2.7) that a model re-transcribed on every merge. All of it is
 * deterministic, so it lives here. merge.mjs is unchanged and still owns the
 * merge itself; this script resolves its inputs, runs the pre-checks, and stops
 * at the points that need a human answer.
 *
 * Three exit modes, per the driver contract:
 *   pause banner + exit 0   — a judgement call is needed
 *   needInput JSON + exit 0 — a required input is missing
 *   non-zero                — genuine failure
 *
 * Never exit 0 with no output: a silent success is indistinguishable from a
 * silent failure to a caller branching on those modes.
 *
 * Usage:
 *   node run-merge.mjs --branches b1,b2 [--project-dir <path>]
 *                      [--skip-testing] [--dry-run]
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { queryRow } from "./pipeline-query.mjs";
import { resolvePlansDir, PLANS_DIR_KEYS } from "../../../src/plans-resolver.mjs";
import { unresolvedPlaceholders } from "../../../src/worktree-paths.mjs";
import { connectUnified, close, projectGetByName } from "../../../src/db/index.mjs";

// merge.mjs is our sibling in the PLUGIN tree. Deriving it from projectDir would
// point into the repo being merged, which does not contain the plugin.
const MERGE_MJS = fileURLToPath(new URL("./merge.mjs", import.meta.url));

// No `shell: true`: with an args array it concatenates unescaped (DEP0190), and
// branch names reach here from the caller.
const SPAWN = { encoding: "utf8", windowsHide: true };

// Emitted commands are copied and run by a human or an agent; mixed separators
// in one line are a readability trap on Windows.
const posix = (p) => String(p).split("\\").join("/");

// ── Exit modes ────────────────────────────────────────────────────────────────

// A pause carries three things: what to decide, the state needed to decide it,
// and the literal command to re-run. A pause that makes the reader go hunting
// for context has failed its purpose.
export function banner(what, lines, rerun) {
  const bar = "=".repeat(78);
  return [
    bar,
    `> PAUSE: ${what}`,
    "",
    ...lines,
    "",
    "RE-RUN EXACTLY:",
    `  ${rerun}`,
    bar,
    "",
  ].join("\n");
}

export function needInput(field, hint) {
  return JSON.stringify({ error: "missing_required_field", field, hint }) + "\n";
}

// ── Step 2 — parse the branch list ────────────────────────────────────────────

export function parseBranches(raw) {
  const seen = new Set();
  for (const part of String(raw ?? "").split(/[\s,]+/)) {
    if (part) seen.add(part);
  }
  return [...seen];
}

// ── Step 2.5 — model selection ────────────────────────────────────────────────

// Not a judgement call: the old SKILL.md already stated it as a rule. Any of the
// three booleans means the merge may need reasoning, so Sonnet; otherwise Haiku.
// Opus is never selected.
export function chooseModel({ diverged, needsTesting, dirty }) {
  const fired = [];
  if (diverged) fired.push("diverged branch");
  if (needsTesting) fired.push("(needs testing) in plan");
  if (dirty) fired.push("dirty working tree");
  return fired.length
    ? { model: "sonnet", reason: fired.join(", ") }
    : { model: "haiku", reason: "all clean" };
}

// ── Resolution helpers (Steps 1, 1.5) ─────────────────────────────────────────

function git(args, cwd) {
  const r = spawnSync("git", args, { ...SPAWN, cwd });
  return r.status === 0 ? (r.stdout ?? "").trim() : "";
}

export function resolveTargetBranch(project, feature, projectDir) {
  const override = queryRow(project, feature, "target_branch");
  if (override) return override;
  const head = git(["symbolic-ref", "refs/remotes/origin/HEAD"], projectDir);
  if (head) return head.split("/").pop();
  return git(["config", "init.defaultBranch"], projectDir) || "main";
}

export function featureOf(branch) {
  return String(branch).replace(/^autonomous\//, "");
}

// ── Pre-checks (Steps 2.4, 2.5) ───────────────────────────────────────────────

// Step 2.4 is a refusal, not a pause: there is no decision to make. The dev
// session aborted its rebase, and the fix is a manual rebase plus an explicit
// clear.
export function checkRebaseRequired(project, branches) {
  for (const branch of branches) {
    if (queryRow(project, featureOf(branch), "rebase_required")) {
      return { branch, feature: featureOf(branch) };
    }
  }
  return null;
}

export function collectSignals(project, branches, projectDir, targetBranch) {
  let diverged = false;
  let needsTesting = false;
  const untested = [];
  const missing = [];

  for (const branch of branches) {
    // Distinguish "not an ancestor" (exit 1 — genuinely diverged) from a git
    // error such as an unknown revision (exit 128), which must not read as
    // diverged and silently pick a model.
    const anc = spawnSync(
      "git",
      ["rev-parse", "--verify", "--quiet", `${branch}^{commit}`],
      { ...SPAWN, cwd: projectDir },
    );
    if (anc.status !== 0) {
      missing.push(branch);
      continue;
    }
    const isAnc = spawnSync(
      "git",
      ["merge-base", "--is-ancestor", targetBranch, branch],
      { ...SPAWN, cwd: projectDir },
    );
    if (isAnc.status === 1) diverged = true;
    else if (isAnc.status !== 0) missing.push(branch);

    const planFile = queryRow(project, featureOf(branch), "plan_file");
    if (planFile && existsSync(planFile)) {
      const body = readFileSync(planFile, "utf8");
      for (const line of body.split(/\r?\n/)) {
        if (line.includes("(needs testing)")) {
          needsTesting = true;
          untested.push({ planFile, line: line.trim() });
        }
      }
    }
  }

  const dirty = git(["status", "--short"], projectDir).length > 0;
  return { diverged, needsTesting, dirty, untested, missing };
}

// ── Resume — guards on observable reality ────────────────────────────────────

// The driver's own step list, distinct from merge.mjs's ten internal steps.
export const DRIVER_STEPS = ["squash", "move-plans"];

// Is this step already done? Answered by inspecting the WORLD, never the progress
// marker. A merge half-completes routinely — the squash lands and the plan move
// fails — and branching on the marker re-runs a step whose effect already exists.
export function stepDone(step, world) {
  if (step === "squash") return world.merged === true;
  if (step === "move-plans") return world.planMoved === true;
  return false; // an unrecognised step is never assumed done
}

// First step the world says is still outstanding; null when nothing remains.
export function resumeFrom(world) {
  for (const step of DRIVER_STEPS) {
    if (!stepDone(step, world)) return step;
  }
  return null;
}

// A progress entry for a different subject means another merge is mid-flight over
// the same repo. Refuse rather than interleave.
export function mutexConflict({ existingSubject, requested }) {
  if (!existingSubject) return false;
  return existingSubject !== requested;
}

// Machine-readable lines the SKILL.md tells Claude to mirror into the harness task
// list. The progress record is the source of truth; the session list is a projection.
export function taskLines(kind, steps, { index, status } = {}) {
  if (kind === "create") {
    return steps.map((s) => `[TASK_CREATE] merge: ${s}`).join("\n") + "\n";
  }
  if (kind === "update") return `[TASK_UPDATE] ${index} ${status}\n`;
  if (kind === "delete") {
    return steps.map((_s, i) => `[TASK_DELETE] ${i}`).join("\n") + "\n";
  }
  return "";
}

// Read the world for each guarded step.
export function observeWorld(projectDir, branches, targetBranch, plansDir, project) {
  // Two probes, in the order the orchestrator uses: `ancestor` is fast but blind to
  // squashes, and a squash merge is the normal case here — it rewrites the commits,
  // so the branch never becomes an ancestor. `git cherry` compares patch-ids and
  // prefixes an already-applied commit with "-", which is what actually detects a
  // landed squash. Checking ancestry alone reports a completed merge as pending and
  // the resume re-squashes it.
  const merged = branches.every((b) => {
    const anc = spawnSync("git", ["merge-base", "--is-ancestor", b, targetBranch],
      { ...SPAWN, cwd: projectDir });
    if (anc.status === 0) return true;

    const cherry = spawnSync("git", ["cherry", targetBranch, b],
      { ...SPAWN, cwd: projectDir });
    if (cherry.status !== 0) return false;
    const lines = (cherry.stdout ?? "").trim().split(/\r?\n/).filter(Boolean);
    // Every commit accounted for upstream, and there was something to account for.
    return lines.length > 0 && lines.every((l) => l.startsWith("-"));
  });

  let planMoved = false;
  if (plansDir) {
    planMoved = branches.every((b) => {
      const planFile = queryRow(project, featureOf(b), "plan_file");
      const stem = planFile ? planFile.split(/[/\\]/).pop() : `${featureOf(b)}.md`;
      return existsSync(join(plansDir, "complete", stem));
    });
  }
  return { merged, planMoved };
}

// ── main ──────────────────────────────────────────────────────────────────────

function getFlag(name, argv) {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : null;
}

// Exported with a dependency seam so the resolution and PAUSE paths are testable: they
// depend on live config and the project row, neither of which a test can otherwise supply.
export async function main({ _argv, _config, _projectRow } = {}) {
  const argv = _argv ?? process.argv.slice(2);
  const out = (s) => process.stdout.write(s);

  const branchesRaw = getFlag("branches", argv);
  if (!branchesRaw) {
    out(needInput("branches", "Which branch(es) to merge? e.g. --branches autonomous/my-feature"));
    return 0;
  }
  const branches = parseBranches(branchesRaw);
  if (branches.length === 0) {
    out(needInput("branches", "--branches was empty after parsing; give at least one branch"));
    return 0;
  }

  const projectDir = (getFlag("project-dir", argv) || git(["rev-parse", "--show-toplevel"], process.cwd()))
    .replace(/\\/g, "/");
  if (!projectDir) {
    process.stderr.write("FAILED: not inside a git repository and --project-dir not given\n");
    return 1;
  }
  const project = projectDir.split("/").filter(Boolean).pop();
  const skipTesting = argv.includes("--skip-testing");
  const dryRun = argv.includes("--dry-run");

  // Step 2.4 — hard refusal, before anything else runs.
  const flagged = checkRebaseRequired(project, branches);
  if (flagged) {
    process.stderr.write(
      `REFUSED: ${flagged.branch} has rebase_required=1 — the dev session aborted its rebase.\n` +
        `Rebase it manually, then clear the flag with:\n` +
        `  pipeline rebase-required-set ${project} ${flagged.feature} 0\n`,
    );
    return 1;
  }

  const targetBranch = resolveTargetBranch(project, featureOf(branches[0]), projectDir);
  // One resolver, four precedence tiers — see REFERENCE.md. The driver used to hand-roll a
  // {project}-only substitution here, which saw neither plansDirs[<project>] nor the project
  // row's plans_dir column.
  const projectPlansDir = _projectRow !== undefined
    ? (_projectRow?.plans_dir ?? null)
    : (() => {
        const db = connectUnified();
        try { return projectGetByName(db, project)?.plans_dir ?? null; }
        catch { return null; }
        finally { close(db); }
      })();
  let plansDir = resolvePlansDir({
    project,
    projectRoot: projectDir,
    projectPlansDir,
    _config: _config,
  });
  const signals = collectSignals(project, branches, projectDir, targetBranch);
  if (signals.missing.length) {
    process.stderr.write(
      `FAILED: branch not found in ${projectDir}: ${signals.missing.join(", ")}\n` +
        `Check the name, or fetch it first. Nothing was merged.\n`,
    );
    return 1;
  }

  // A template naming something the plansDir vocabulary cannot supply resolves to a path with
  // the token still in it. That is a config error, and guessing past it is how a wrong
  // --plans-dir reaches a real merge. Checked against PLANS_DIR_KEYS, not the global list:
  // {branch} is a legal placeholder elsewhere and is never substituted here.
  //
  // Ordered after the branch check (a typo'd branch is the more actionable failure) and
  // before the existence fallback below, which must only ever see a substituted path.
  const unresolved = unresolvedPlaceholders(plansDir, PLANS_DIR_KEYS);
  if (unresolved.length) {
    const source = projectPlansDir
      ? `the ${project} project row's plans_dir column`
      : `plansDirs["${project}"] or plansDir in ~/.pipeline/config.json`;
    out(
      banner(
        "Plans directory template cannot resolve",
        [
          `  resolved:   ${posix(plansDir)}`,
          `  unresolved: ${unresolved.map((t) => `{${t}}`).join(", ")}`,
          `  from:       ${source}`,
          "",
          `  valid for a plans dir: ${PLANS_DIR_KEYS.map((k) => `{${k}}`).join(" ")}`,
          `  e.g.  "{root_parent}/CLAUDE/repos/{project}/plans"`,
          "",
          "  Fix the template, then re-run. Nothing was merged.",
        ],
        `node "${posix(process.argv[1])}" --branches "${branches.join(",")}" ` +
          `--project-dir "${projectDir}"`,
      ),
    );
    return 0;
  }

  // A configured plans dir can legitimately not apply to THIS repo. Falling back to the
  // repo's own plans/ keeps the plan-move guard answerable; without it `planMoved` is
  // permanently false and the resume never completes.
  if ((!plansDir || !existsSync(plansDir)) && existsSync(join(projectDir, "plans"))) {
    plansDir = join(projectDir, "plans").replace(/\\/g, "/");
  }

  // Resume: ask the WORLD what is already done before proposing any work. A merge
  // half-completes routinely — the squash lands and the plan move fails — and the
  // re-run must pick up at the plan move rather than squashing twice.
  const world = observeWorld(projectDir, branches, targetBranch, plansDir, project);
  const next = resumeFrom(world);
  if (next === null) {
    out(
      `Nothing to do — this merge is already complete.\n` +
        `  squash:     landed (${branches.join(", ")} already applied to ${targetBranch})\n` +
        `  move-plans: done (plan(s) already in complete/)\n`,
    );
    return 0;
  }
  if (next !== DRIVER_STEPS[0]) {
    out(
      `Resuming at "${next}" — earlier steps already landed:\n` +
        `  squash:     ${world.merged ? "landed" : "pending"}\n` +
        `  move-plans: ${world.planMoved ? "done" : "pending"}\n\n`,
    );
  }

  // Step 4's prompt, hoisted to where it belongs: before the spawn, as a pause.
  if (signals.needsTesting && !skipTesting) {
    const rerun =
      `node "${posix(process.argv[1])}" --branches "${branches.join(",")}" ` +
      `--project-dir "${projectDir}" --skip-testing`;
    out(
      banner(
        "Untested items in the plan",
        [
          "These items are marked (needs testing) and this merge would ship them:",
          "",
          ...signals.untested.map((u) => `  ${u.line}\n    in ${u.planFile}`),
          "",
          "Ask the user: skip and mark as (skipped) to force through?",
          "  yes -> re-run with --skip-testing (rewrites the markers, WARNING in the merge log)",
          "  no  -> stop; tell them to complete testing first",
        ],
        rerun,
      ),
    );
    return 0;
  }

  const { model, reason } = chooseModel(signals);

  // The driver prints a fully-resolved invocation rather than the SKILL.md
  // carrying a template with placeholders for a model to fill in.
  const plansFlag = plansDir ? ` --plans-dir "${plansDir}"` : "";
  const skipFlag = skipTesting ? " --skip-testing" : "";
  const mergeCmd =
    `node "${posix(MERGE_MJS)}" ` +
    `--branches "${branches.join(",")}" --project-dir "${projectDir}" ` +
    `--target-branch "${targetBranch}"${plansFlag}${skipFlag}`;

  out(
    [
      `resolved:`,
      `  project:       ${project}`,
      `  projectDir:    ${projectDir}`,
      `  branches:      ${branches.join(", ")}`,
      `  targetBranch:  ${targetBranch}`,
      `  plansDir:      ${plansDir ?? "(unset — merge.mjs default)"}`,
      `  diverged:      ${signals.diverged}`,
      `  needsTesting:  ${signals.needsTesting}${skipTesting ? " (overridden by --skip-testing)" : ""}`,
      `  dirtyTree:     ${signals.dirty}`,
      "",
      `model: ${model} (${reason})`,
      "",
      dryRun ? "DRY RUN — would spawn a background agent running:" : "Spawn a background agent running:",
      `  ${mergeCmd}`,
      "",
    ].join("\n"),
  );
  return 0;
}

// Guard the entry point by resolved path, not by basename: ~/.claude/skills is a
// symlink into the real tree, so argv[1] and import.meta.url disagree there and a
// basename comparison silently refuses to run (observed in run-workflow.mjs,
// 2026-08-20).
const invokedAs = process.argv[1] ? new URL(`file://${process.argv[1].replace(/\\/g, "/")}`).pathname : "";
const selfPath = new URL(import.meta.url).pathname;
if (invokedAs && (invokedAs === selfPath || invokedAs.endsWith("/run-merge.mjs"))) {
  main()
    .then((code) => setTimeout(() => process.exit(code), 150))
    .catch((e) => {
      process.stderr.write(`FAILED: ${e.message}\n`);
      setTimeout(() => process.exit(1), 150);
    });
}
