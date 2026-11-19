// merge-world.mjs — the resume contract: what the merge has already done.
// Every guard answers from the repository, never from the progress marker:
// a merge half-completes routinely, so the marker re-runs landable steps.
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

// The stable patch id of the diff `args` produces, or "" when either step fails.
function patchId(cwd, args) {
  const diff = spawnSync("git", args, { ...SPAWN, cwd });
  if (diff.status !== 0) return "";
  const id = spawnSync("git", ["patch-id", "--stable"], { ...SPAWN, cwd, input: diff.stdout ?? "" });
  return id.status === 0 ? ((id.stdout ?? "").trim().split(/\s+/)[0] ?? "") : "";
}

// A squash of a branch with more than one commit: no individual commit is
// upstream, but the branch's combined diff from its merge-base is the patch of
// exactly one commit on the target.
function squashLanded(cwd, ref, branch) {
  const mb = git(["merge-base", ref, branch], cwd);
  if (!mb) return false;
  const branchPatch = patchId(cwd, ["diff", mb, branch]);
  if (!branchPatch) return false;
  const commits = git(["rev-list", `${mb}..${ref}`], cwd).split(/\r?\n/).filter(Boolean);
  return commits.some((c) => patchId(cwd, ["diff", `${c}^`, c]) === branchPatch);
}

// Read the world for each guarded step.
export function observeWorld(projectDir, branches, targetBranch, plansDir, project) {
  const ref = worldRef(projectDir, targetBranch);

  // Three probes, each catching a shape the others miss. Ancestry sees a
  // fast-forward. `git cherry` sees commits applied individually (every line
  // "-"). Neither sees the normal case — a multi-commit branch squashed into one
  // commit, where cherry prints "+" for every line — so the combined diff's
  // patch-id is compared against each commit on the target. Without the third
  // probe a completed squash reads pending and the resume re-squashes it.
  const merged = branches.every((b) => {
    if (gitOk(projectDir, "merge-base", "--is-ancestor", b, ref)) return true;

    const cherry = spawnSync("git", ["cherry", ref, b],
      { ...SPAWN, cwd: projectDir });
    if (cherry.status === 0) {
      const lines = (cherry.stdout ?? "").trim().split(/\r?\n/).filter(Boolean);
      // Every commit accounted for upstream, and there was something to account for.
      if (lines.length > 0 && lines.every((l) => l.startsWith("-"))) return true;
    }
    return squashLanded(projectDir, ref, b);
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
