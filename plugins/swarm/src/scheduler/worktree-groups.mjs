// Worktree grouping (which task collects a shared tree, which may reset it) and
// the branch topology an integrate node resolves its sources through.
import { readResult } from "../results.mjs";
import { makeReaches } from "../manifest.mjs";
import { parseCloneId } from "../runlog.mjs";

export function createWorktreeGroups(ctx) {
  const { cfg, plan, tasks, worktree } = ctx;

  // The branch a task id resolves to, for `integrate.from`. An integrate node is
  // `after` its sources, so their branches are recorded facts by then — re-deriving
  // the name is how a tree adopted under another node's name got merged as a ref
  // nobody created. The fallback survives only for a source that recorded nothing.
  const branchOf = (srcId) => {
    const recorded = readResult(plan.resultsDir, srcId)?.worktree?.branch;
    if (recorded) return recorded;
    const src = tasks.find((o) => o.id === srcId);
    return worktree.branchNameFor(
      src ? { ...src, worktreeName: ctx.nameOf(src) ?? src.id } : { id: srcId }, cfg);
  };

  // Tasks any integrate node names: their branches must survive the sweep even
  // when empty, because the merge needs the ref, not its contents.
  const integrateSources = new Set(tasks.flatMap((t) => t.integrate?.from ?? []));

  // A forEach parent named in integrate.from owns no branch itself — its clones
  // do. A clone's own id is never authored into integrate.from (it doesn't
  // exist until expansion), so its protection is inherited from its parent.
  const cloneParentOf = (id) => parseCloneId(id)?.parent;
  const isIntegrateSourceId = (id) => integrateSources.has(id) || integrateSources.has(cloneParentOf(id));

  // integrate.from naming a forEach parent means every clone that expanded
  // from it, resolved at merge time in index order — the parent itself never
  // gets a branch (D1, foreach-integrate-fold-back). A plain id passes through.
  const resolveIntegrateFrom = (fromList) => fromList.flatMap((id) => {
    const t = tasks.find((o) => o.id === id);
    return t?.aggregate ? t.after : [id];
  });

  // Rebuilt after every splice: forEach clones and manifest children join the
  // run mid-flight, and a group map that predates them would leave their trees
  // uncollected and un-resettable.
  const rebuildGroups = () => {
    ctx.groupMembers.clear(); ctx.groupFinal.clear(); ctx.groupFirst.clear();
    for (const t of tasks) {
      const n = ctx.nameOf(t);
      if (!n) continue;
      if (!ctx.groupMembers.has(n)) ctx.groupMembers.set(n, []);
      ctx.groupMembers.get(n).push(t.id);
    }
    // Reachability must be GLOBAL, not group-local: members of one tree can be ordered
    // through tasks in other groups, and a group-local scan would pick the FIRST task as
    // collector and sweep the tree before the last member ran — dropping its work.
    const reaches = makeReaches(tasks);
    for (const [name, ids] of ctx.groupMembers) {
      ctx.groupFinal.set(name, ids.find((id) => !ids.some((o) => o !== id && reaches(o, id))) ?? ids[ids.length - 1]);
      ctx.groupFirst.set(name, ids.find((id) => !ids.some((o) => o !== id && reaches(id, o))) ?? ids[0]);
    }
  };
  rebuildGroups();

  return { branchOf, isIntegrateSourceId, resolveIntegrateFrom, rebuildGroups };
}
