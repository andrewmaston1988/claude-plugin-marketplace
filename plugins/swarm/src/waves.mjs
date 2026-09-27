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
