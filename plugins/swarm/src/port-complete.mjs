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
    for (const name of MARKERS) {
      const marker = git(["rev-parse", "--git-path", name], tree);
      if (marker.status !== 0 || !marker.stdout) return true;
      if (existsSync(resolve(tree, marker.stdout))) return true;
    }
    const unmerged = git(["diff", "--name-only", "--diff-filter=U"], tree);
    return unmerged.status !== 0 || Boolean(String(unmerged.stdout || "").trim());
  } catch {
    return true;
  }
}
