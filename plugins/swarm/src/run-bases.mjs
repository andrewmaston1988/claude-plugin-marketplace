// The run's base commits: one per repo, pinned when the run starts.
//
// A tree cut from the live HEAD at LAUNCH is cut from whatever landed in the
// checkout since dispatch — so a leaf that waited on `after` silently starts on
// commits the plan never saw, and its diff carries them. captureBases reads HEAD
// once per repo before anything dispatches, persists it beside the results, and
// every tree is then cut from that pinned commit (worktree.mjs).
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

// Capture — or reuse — one base commit per repo this run will cut trees from.
// A resume re-enters the trees an earlier engine built, so it must reuse their
// base; `force` is a cold redo and deliberately recaptures.
//
// Only tasks that get a tree are asked for a repo: a repo the run cuts nothing
// from is not captured, so `baseFor` can treat a miss as the bug it is.
export function captureBases(tasks, { resultsDir, cwd }, io = {}, { force = false } = {}) {
  const file = join(resultsDir, BASES_FILE);
  if (!force) {
    const persisted = readPersisted(file);
    if (persisted) return persisted;
  }
  const readHead = io.repoHead || repoHead;
  // A manifest node's children splice in at run time and carry their own trees,
  // so they must be pinned here or they have no base when they launch.
  const bases = new Map();
  for (const t of tasks.flatMap((t) => (t.childPlan ? t.childPlan.tasks : [t]))) {
    if (resolveWorktreeName(t) === undefined) continue;
    // Mirrors each caller's own derivation: integrate() falls back to the
    // dispatch cwd, prepareIsolation to the task's cwd. A base pinned for a
    // different repo than the tree is cut from is worth less than none.
    const repo = t.originalCwd || (t.integrate !== undefined ? cwd : t.cwd);
    if (!repo) continue;
    const top = checkoutToplevel(repo);
    // Outside git there is no commit to pin and no real tree to cut — a fake
    // worktree (tests, a caller-supplied one) decides for itself.
    if (!top || bases.has(top)) continue;
    const sha = readHead(repo);
    if (!sha) throw new Error(`cannot resolve HEAD in ${repo} — a task with a tree needs a repo to cut it from`);
    bases.set(top, sha);
  }
  writeBases(file, bases);
  return bases;
}

// The pinned commit for `repo`'s checkout. A repo the run never captured is a
// bug, not a fallback — reading the live HEAD here is the defect this module
// exists to remove. A path outside git has no tree to base, so it resolves to
// nothing and whatever worktree is behind it decides.
export function baseFor(bases, repo) {
  const top = checkoutToplevel(repo);
  if (!top) return undefined;
  if (bases.has(top)) return bases.get(top);
  throw new Error(`${top} has no pinned base commit for this run — it was not captured at dispatch`);
}
