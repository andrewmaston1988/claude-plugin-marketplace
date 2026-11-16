// A port is provable only once git has finished it: a pick still open, a revert, a merge,
// a rebase, a queued sequencer or an unmerged index all mean HEAD moves again on the next
// command. Markers resolve through `--git-path` because a linked worktree keeps them in the
// main repo's admin dir, not under `<tree>/.git`.
import { existsSync } from "node:fs";
import { resolve } from "node:path";

const MARKERS = ["CHERRY_PICK_HEAD", "REVERT_HEAD", "MERGE_HEAD", "rebase-merge", "rebase-apply", "sequencer"];

// Anything git cannot answer reads as in progress: no record is better than a wrong one.
export function portInProgress(tree, git) {
  if (typeof git !== "function") throw new TypeError("portInProgress requires a git runner");
  try {
    const markers = git(["rev-parse", ...MARKERS.flatMap((name) => ["--git-path", name])], tree);
    if (markers.status !== 0 || !markers.stdout) return true;
    const paths = String(markers.stdout).split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
    // A short answer means git could not name every marker.
    if (paths.length !== MARKERS.length) return true;
    if (paths.some((path) => existsSync(resolve(tree, path)))) return true;
    const unmerged = git(["diff", "--name-only", "--diff-filter=U"], tree);
    return unmerged.status !== 0 || Boolean(String(unmerged.stdout || "").trim());
  } catch {
    return true;
  }
}
