// The run's base commits: one per repo, pinned at dispatch. A tree cut from the
// live HEAD at LAUNCH instead carries whatever landed in the checkout since — so
// this reads HEAD once per repo, persists it, and every tree is cut from that.
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { resolveWorktreeName } from "./manifest-task-policy.mjs";
import { checkoutToplevel, repoHead } from "./worktree.mjs";

export const BASES_FILE = "bases.json";

const SHA_RE = /^[0-9a-f]{40}$/;

// A corrupt base file must abort the run, never silently recapture: recapturing
// on a resume hands every later tree a different commit than the trees already
// built on, which is worse than the corruption it papers over.
function readPersisted(file) {
  if (!existsSync(file)) return null;
  let raw;
  try {
    raw = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    throw new Error(`${BASES_FILE} is not valid JSON — delete it to recapture this run's base commits`);
  }
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error(`${BASES_FILE} must map a repo path to its dispatch commit`);
  }
  for (const [repo, sha] of Object.entries(raw)) {
    if (typeof sha !== "string" || !SHA_RE.test(sha)) {
      throw new Error(`${BASES_FILE} holds a malformed commit for ${repo} (${JSON.stringify(sha)}) — delete it to recapture it`);
    }
  }
  return new Map(Object.entries(raw));
}

function writeBases(file, bases) {
  // Atomic: a torn bases.json would poison every later resume of this run.
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(Object.fromEntries(bases), null, 2)}\n`);
  renameSync(tmp, file);
}

// True when this task cuts a tree of its own. `resolveWorktreeName` answers
// undefined for an integrate node even though runIntegrate creates its
// `integrate.into` tree at call time — so it needs a pinned base too.
function holdsTree(t) {
  return resolveWorktreeName(t) !== undefined || t.integrate?.into !== undefined;
}

// Capture — or reuse — one base commit per repo this run will cut trees from.
// A resume re-enters the trees an earlier engine built, so it keeps their base and
// captures only the repos still missing one (a plan edited between runs can add
// one); `force` is a cold redo and recaptures every repo.
//
// Only tasks that get a tree are asked for a repo: a repo the run cuts nothing
// from is not captured, so `baseFor` can treat a miss as the bug it is.
export function captureBases(tasks, { resultsDir, cwd }, io = {}, { force = false } = {}) {
  const file = join(resultsDir, BASES_FILE);
  const bases = force ? new Map() : readPersisted(file) || new Map();
  const readHead = io.repoHead || repoHead;
  // One `git rev-parse --show-toplevel` per distinct repo, not per task.
  const tops = new Map();
  const topOf = (repo) => {
    if (!tops.has(repo)) tops.set(repo, checkoutToplevel(repo));
    return tops.get(repo);
  };
  // A manifest node's children splice in at run time and carry their own trees,
  // so they must be pinned here or they have no base when they launch.
  for (const t of tasks.flatMap((t) => (t.childPlan ? t.childPlan.tasks : [t]))) {
    if (!holdsTree(t)) continue;
    // Mirrors each caller's own derivation: integrate() falls back to the
    // dispatch cwd, prepareIsolation to the task's cwd. A base pinned for a
    // different repo than the tree is cut from is worth less than none.
    const repo = t.originalCwd || (t.integrate !== undefined ? cwd : t.cwd);
    if (!repo) continue;
    const top = topOf(repo);
    // Outside git there is no commit to pin and no real tree to cut — a fake
    // worktree (tests, a caller-supplied one) decides for itself.
    if (!top || bases.has(top)) continue;
    const sha = readHead(repo);
    if (!sha) throw new Error(`cannot resolve HEAD in ${repo} — a task with a tree needs a repo to cut it from`);
    bases.set(top, sha);
  }
  // Unconditional: a `force` recapture that pins nothing must still clear the stale
  // file, or the next resume reads bases from the run --force was meant to redo.
  writeBases(file, bases);
  return bases;
}

// The pinned commit for `repo`'s checkout. A repo the run never captured is a bug,
// not a fallback — reading the live HEAD here is the defect this module exists to
// remove — so the message names the repo and the one remedy that works. A path
// outside git has no tree to base, so it resolves to nothing and whatever
// worktree is behind it decides.
export function baseFor(bases, repo, resultsDir) {
  const top = checkoutToplevel(repo);
  if (!top) return undefined;
  if (bases.has(top)) return bases.get(top);
  const remedy = resultsDir
    ? ` — stop the run and delete ${join(resultsDir, BASES_FILE)} so the next one recaptures every repo it needs`
    : "";
  throw new Error(`${top} has no pinned base commit for this run: it was not captured at dispatch${remedy}`);
}
