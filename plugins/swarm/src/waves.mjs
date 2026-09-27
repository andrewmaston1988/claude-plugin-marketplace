import { parseCloneId } from "./leaf-ids.mjs";

// The forEach a live task id belongs to: a clone, or any child spliced under one.
export function cloneTreeParent(id) {
  for (let cut = id; ; cut = cut.slice(0, cut.lastIndexOf("~"))) {
    const clone = parseCloneId(cut);
    if (clone) return clone.parent;
    if (cut.lastIndexOf("~") <= 0) return undefined;
  }
}

// Shared wave depth calculation for the dashboard and scheduler. The resolvers
// keep each caller's task representation out of this graph rule.
export function waveDepths(tasks, { afterOf = (task) => task.after || [], parentOf = () => undefined } = {}) {
  const byId = new Map(tasks.map((task) => [task.id, task]));
  const depth = new Map();
  const visiting = new Set();
  const depthOf = (id) => {
    if (depth.has(id)) return depth.get(id);
    if (visiting.has(id)) return 0;
    visiting.add(id);
    const task = byId.get(id);
    const parent = task && parentOf(task);
    let value = 0;
    if (parent && byId.has(parent)) value = depthOf(parent);
    else for (const dependency of task ? afterOf(task) || [] : []) {
      if (byId.has(dependency)) value = Math.max(value, depthOf(dependency) + 1);
    }
    visiting.delete(id);
    depth.set(id, value);
    return value;
  };
  for (const task of tasks) depthOf(task.id);
  return depth;
}

// The launch order of a ready set: shallower waves first, ties keeping the
// plan's own order. A task's wave edge is `waveAfter` where its `after` has been
// rewritten to point at its own children — a manifest node splices its children
// in and a forEach parent re-points at its clones, and in both cases the upstream
// the task was seated on stays the edge that seats it.
export function seatOrder(readyLeaves, tasks) {
  const depths = waveDepths(tasks, {
    afterOf: (task) => task.waveAfter || task.after,
    parentOf: (task) => cloneTreeParent(task.id),
  });
  const index = new Map(tasks.map((task, i) => [task.id, i]));
  return readyLeaves.sort((a, b) => depths.get(a.id) - depths.get(b.id) || index.get(a.id) - index.get(b.id));
}
