// A writer's deliverable is its commits: a merge takes the branch ref, so edits still
// sitting in the tree are dropped without a word. This gate is the leaf contract's
// git-state member — one corrective turn in the leaf's own session, then a failure.
import { reaskLeaf } from "./leaf-contract.mjs";
import { holdsEditTools } from "../manifest-task-policy.mjs";

export const UNCOMMITTED_WORK = "UNCOMMITTED_WORK";

// `files: null` is a status git could not answer. It counts as dirty: passing a leaf
// on an unanswered question is how its edits get lost.
const unmeasured = (u) => u?.files === null;
const isDirty = (collected) => unmeasured(collected.uncommitted) || collected.uncommitted?.files > 0;
const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;

// The run.log note on the failed state line.
export const uncommittedNote = (u) =>
  unmeasured(u) ? "uncommitted: tree could not be measured" : `uncommitted: ${plural(u.files, "file")}`;

// `taskIds` is the whole tree group: only its final link is judged, but the tree is
// shared, so the leaf is told whose edits it is answering for.
function commitAsk(u, taskIds) {
  const shared = taskIds?.length > 1 ? ` (a tree shared by ${taskIds.join(", ")})` : "";
  const state = unmeasured(u)
    ? `Your tree${shared} could not be measured — git status failed there.`
    : `${u.files} file${u.files === 1 ? " is" : "s are"} uncommitted in your tree${shared}.`;
  return `${state} Commit the work you intend to keep, or revert it, then end your turn.`;
}

// `collect` is the worktree's own, once per group, and may remove a clean tree — so
// this owns the call and hands the final measurement back. An `ok` result keeps the
// leaf's ORIGINAL output: the re-ask is housekeeping, and its reply ("committed")
// would otherwise replace the answer the contract already validated.
//
// Only a leaf holding Edit or Write is judged. A Bash-only leaf (reviewer, verifier)
// runs commands and authors nothing, so its tree is handed back as it always was.
export async function enforceCommitted(task, r, collect, taskIds, deps) {
  let collected = collect();
  if (!holdsEditTools(task.allowedTools)) {
    const { uncommitted, ...rest } = collected;
    return { r, collected: rest };
  }
  if (!r.ok || !isDirty(collected)) return { r, collected };

  let cur = r;
  if (r.sessionId) {
    const asked = await reaskLeaf(task, r, commitAsk(collected.uncommitted, taskIds), {
      ...deps, log: { attempt: 1, reason: "uncommitted", files: collected.uncommitted.files },
    });
    cur = asked.combined;
    collected = collect();
    if (!isDirty(collected)) return { r: cur, collected };
  }

  const { files, commitsAhead } = collected.uncommitted;
  const group = taskIds?.length > 1 ? ` [tasks: ${taskIds.join(", ")}]` : "";
  const what = unmeasured(collected.uncommitted)
    ? `the tree in ${collected.branch} could not be measured (git status failed)`
    : `${plural(files, "file")} left uncommitted in ${collected.branch} (${plural(commitsAhead, "commit")} ahead)`;
  return {
    r: {
      ...cur, ok: false, errorCode: UNCOMMITTED_WORK, uncommitted: collected.uncommitted,
      // What a re-run resumes from, the same way a schema failure keeps its own output.
      rawOutput: r.output,
      output: `${UNCOMMITTED_WORK}: ${what}${r.sessionId ? " after one commit re-ask" : ""}${group}. ` +
        "The tree is kept; re-running resumes the leaf there to commit.",
    },
    collected,
  };
}
