// A writer's deliverable is its commits: a merge takes the branch ref, so edits still
// sitting in the tree are dropped without a word. This gate is the leaf contract's
// git-state member — one corrective turn in the leaf's own session, then a failure.
import { reaskLeaf } from "./leaf-contract.mjs";

export const UNCOMMITTED_WORK = "UNCOMMITTED_WORK";

const isDirty = (collected) => collected.uncommitted?.files > 0;

// `taskIds` is the whole tree group: only its final link is judged, but the tree is
// shared, so the leaf is told whose edits it is answering for.
function commitAsk(files, taskIds) {
  const shared = taskIds?.length > 1 ? ` (a tree shared by ${taskIds.join(", ")})` : "";
  return `${files} file${files === 1 ? " is" : "s are"} uncommitted in your tree${shared}. ` +
    "Commit the work you intend to keep, or revert it, then end your turn.";
}

// `collect` is the worktree's own, once per group, and may remove a clean tree — so
// this owns the call and hands the final measurement back. An `ok` result keeps the
// leaf's ORIGINAL output: the re-ask is housekeeping, and its reply ("committed")
// would otherwise replace the answer the contract already validated.
export async function enforceCommitted(task, r, collect, taskIds, deps) {
  let collected = collect();
  if (!r.ok || !isDirty(collected)) return { r, collected };

  let cur = r;
  if (r.sessionId) {
    const asked = await reaskLeaf(task, r, commitAsk(collected.uncommitted.files, taskIds), {
      ...deps, log: { attempt: 1, reason: "uncommitted", files: collected.uncommitted.files },
    });
    cur = asked.combined;
    collected = collect();
    if (!isDirty(collected)) return { r: cur, collected };
  }

  const { files, commitsAhead } = collected.uncommitted;
  const group = taskIds?.length > 1 ? ` [tasks: ${taskIds.join(", ")}]` : "";
  return {
    r: {
      ...cur, ok: false, errorCode: UNCOMMITTED_WORK, uncommitted: collected.uncommitted,
      // What a re-run resumes from, the same way a schema failure keeps its own output.
      rawOutput: r.output,
      output: `${UNCOMMITTED_WORK}: ${files} file${files === 1 ? "" : "s"} left uncommitted in ${collected.branch} ` +
        `(${commitsAhead} commit${commitsAhead === 1 ? "" : "s"} ahead)${r.sessionId ? " after one commit re-ask" : ""}${group}. ` +
        "The tree is kept; re-running resumes the leaf there to commit.",
    },
    collected,
  };
}
