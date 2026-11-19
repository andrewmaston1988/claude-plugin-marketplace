// merge-world.mjs — the resume contract: what the merge has already done.
//
// Every guard answers from the repository (or origin, or a parked ref), never
// from the progress marker. A merge half-completes routinely — the squash lands
// and the plan move fails — and branching on the marker re-runs a step whose
// effect already exists.
import { existsSync } from "node:fs";
import { join, relative, isAbsolute } from "node:path";
import { spawnSync } from "node:child_process";
import { queryRow } from "./pipeline-query.mjs";

// No `shell: true`: with an args array it concatenates unescaped (DEP0190), and
// branch names reach here from the caller.
export const SPAWN = { encoding: "utf8", windowsHide: true };

// Trimmed stdout on success, "" on failure.
export function git(args, cwd) {
  const r = spawnSync("git", args, { ...SPAWN, cwd });
  return r.status === 0 ? (r.stdout ?? "").trim() : "";
}

export function featureOf(branch) {
  return String(branch).replace(/^autonomous\//, "");
}

// ── Resume — guards on observable reality ────────────────────────────────────

// The driver's own step list, distinct from merge.mjs's ten internal steps.
export const DRIVER_STEPS = ["squash", "move-plans", "land"];

// Is this step already done? Answered by inspecting the WORLD, never the progress
// marker.
export function stepDone(step, world) {
  if (step === "squash") return world.merged === true;
  if (step === "move-plans") return world.planMoved === true;
  if (step === "land") return world.landed === true;
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

// The ref the world is read from: what origin holds, else a parked squash, else
// the local target. Reading origin is what lets a resume see a merge that was
// pushed while the shared checkout was behind.
function worldRef(projectDir, targetBranch) {
  const hasOrigin = git(["remote", "get-url", "origin"], projectDir).length > 0;
  if (hasOrigin) {
    git(["fetch", "origin", targetBranch], projectDir);
    if (git(["rev-parse", "--verify", "--quiet", `origin/${targetBranch}`], projectDir).length > 0) {
      return `origin/${targetBranch}`;
    }
  }
  if (git(["rev-parse", "--verify", "--quiet", `refs/merge/${targetBranch}`], projectDir).length > 0) {
    return `refs/merge/${targetBranch}`;
  }
  return targetBranch;
}

function gitOk(cwd, ...args) {
  return spawnSync("git", args, { ...SPAWN, cwd }).status === 0;
}

// Read the world for each guarded step.
export function observeWorld(projectDir, branches, targetBranch, plansDir, project) {
  const ref = worldRef(projectDir, targetBranch);

  // Two probes, in the order the orchestrator uses: `ancestor` is fast but blind to
  // squashes, and a squash merge is the normal case here — it rewrites the commits,
  // so the branch never becomes an ancestor. `git cherry` compares patch-ids and
  // prefixes an already-applied commit with "-", which is what actually detects a
  // landed squash. Checking ancestry alone reports a completed merge as pending and
  // the resume re-squashes it.
  const merged = branches.every((b) => {
    if (gitOk(projectDir, "merge-base", "--is-ancestor", b, ref)) return true;

    const cherry = spawnSync("git", ["cherry", ref, b],
      { ...SPAWN, cwd: projectDir });
    if (cherry.status !== 0) return false;
    const lines = (cherry.stdout ?? "").trim().split(/\r?\n/).filter(Boolean);
    // Every commit accounted for upstream, and there was something to account for.
    return lines.length > 0 && lines.every((l) => l.startsWith("-"));
  });

  let planMoved = false;
  if (plansDir) {
    const relDir = relative(projectDir, plansDir);
    const plansInRepo = Boolean(relDir) && !relDir.startsWith("..") && !isAbsolute(relDir);
    planMoved = branches.every((b) => {
      const planFile = queryRow(project, featureOf(b), "plan_file");
      const stem = planFile ? planFile.split(/[/\\]/).pop() : `${featureOf(b)}.md`;
      if (plansInRepo) {
        const rel = `${relDir.split("\\").join("/")}/complete/${stem}`;
        return gitOk(projectDir, "cat-file", "-e", `${ref}:${rel}`);
      }
      // Plans outside the repo have no tree entry to read on the ref.
      return existsSync(join(plansDir, "complete", stem));
    });
  }

  // The shared checkout already contains what the ref holds: nothing left to land.
  const landed = gitOk(projectDir, "merge-base", "--is-ancestor", ref, targetBranch);

  return { merged, planMoved, landed, ref };
}
