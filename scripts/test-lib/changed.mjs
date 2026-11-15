// The changed set a diff-aware run starts from: everything this branch has
// done, plus everything still uncommitted, plus every untracked file. Three
// sources because any one of them alone reads as "nothing changed" while real
// edits sit in the tree -- and a diff-aware runner that misses an edit silently
// runs none of the right tests.

import { spawnSync } from "node:child_process";

/** The input could not be read. The runner turns this into exit 2: a changed
 *  set it could not compute is never "nothing changed". */
export class ChangedSetError extends Error {}

const BASE_CANDIDATES = ["origin/master", "master"];

function git(args, cwd, _spawnSync, what) {
  const r = _spawnSync("git", args, { cwd, encoding: "buffer" });
  if (!r || r.error || r.status !== 0) {
    const detail = r && r.stderr ? r.stderr.toString("utf8").trim() : "";
    throw new ChangedSetError(`${what} (git ${args.join(" ")})${detail ? `: ${detail}` : ""}`);
  }
  return r.stdout.toString("utf8");
}

/** `-z` output split on NUL. A path with a space or a non-ASCII byte stays one
 *  field, which newline-delimited `--name-only` does not guarantee. */
function splitZ(text) {
  return text.split("\0").filter((field) => field !== "");
}

function refExists(ref, cwd, _spawnSync) {
  const r = _spawnSync("git", ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`], {
    cwd,
    encoding: "buffer",
  });
  return Boolean(r) && !r.error && r.status === 0;
}

/** The commit the diff is measured from: `--against <ref>`, else the merge-base with
 *  `origin/master`, then `master`, so a base that moved since the fork reports none of
 *  its own commits. Neither ref and no `--against` throws rather than guess. */
export function resolveBase({ repoRoot, against = null, _spawnSync = spawnSync }) {
  if (against) {
    if (!refExists(against, repoRoot, _spawnSync)) {
      throw new ChangedSetError(`--against ${against} is not a ref git can resolve`);
    }
    return against;
  }
  for (const ref of BASE_CANDIDATES) {
    if (!refExists(ref, repoRoot, _spawnSync)) continue;
    return git(["merge-base", ref, "HEAD"], repoRoot, _spawnSync, `the merge-base with ${ref}`).trim();
  }
  throw new ChangedSetError(
    "no base ref: neither origin/master nor master exists here. Pass --against <ref> to name one.",
  );
}

/** Repo-relative posix paths, sorted and de-duplicated.
 *
 *  Deleted paths are kept: they name a file a test's closure held, and the
 *  closure walk simply will not find them on disk -- which is the same
 *  over-selection a rename gets, and safe. */
export function changedSet({ repoRoot, base, _spawnSync = spawnSync }) {
  const lists = [
    git(["diff", "--name-only", "-z", `${base}...HEAD`], repoRoot, _spawnSync, "the branch diff"),
    // No ref: staged and unstaged both, which is the whole working tree.
    git(["diff", "--name-only", "-z", "HEAD"], repoRoot, _spawnSync, "the uncommitted changes"),
    git(["ls-files", "--others", "--exclude-standard", "-z"], repoRoot, _spawnSync, "the untracked files"),
  ];
  const seen = new Set();
  for (const list of lists) {
    for (const raw of splitZ(list)) {
      const path = raw.replace(/\\/g, "/");
      if (path !== "") seen.add(path);
    }
  }
  return [...seen].sort();
}
