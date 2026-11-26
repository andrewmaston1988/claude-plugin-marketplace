// The contract lines of the validate approval surface: which tasks are held to a
// shape, to their citations, to their reading, and to an author-named check.
import { citationPaths } from "./citations.mjs";
import { CONTRACT_CHECK_REASKS } from "./scheduler/leaf-contract.mjs";

// Child-manifest leaves are spliced into the run as `<node>~<childId>`, so the
// approval names them the way the run will.
function withChildLeaves(tasks, prefix = "") {
  return tasks.flatMap((t) => {
    const id = prefix ? `${prefix}~${t.id}` : t.id;
    const self = { ...t, id };
    return t.childPlan ? [self, ...withChildLeaves(t.childPlan.tasks, id)] : [self];
  });
}

export function contractSummaryLines(tasks) {
  const lines = [];
  tasks = withChildLeaves(tasks);
  // returns schemas are part of the approval surface: say which tasks are
  // guaranteed shape, and what the guarantee costs when output misses.
  const ret = tasks.filter((t) => t.returns);
  if (ret.length) {
    lines.push(`returns validated: ${ret.map((t) => t.id).join(", ")} (invalid output gets up to 3 corrective re-asks, then fails)`);
  }
  // N3: mechanical verification is approval-surface behavior — say which tasks
  // will have their {file,line,quote} citations checked against real files.
  const cited = ret.filter((t) => t.verifyCitations !== false && citationPaths(t.returns).length);
  if (cited.length) {
    lines.push(`citations verified mechanically: ${cited.map((t) => t.id).join(", ")} (file/line/quote checked against the task cwd; a refuted citation gets one corrective re-ask, then is annotated — never fails the leaf)`);
  }
  // Read coverage is approval-surface too, and independent of returns: name the
  // tasks whose transcript will be checked against their mustRead declaration.
  const mustRead = tasks.filter((t) => t.mustRead);
  if (mustRead.length) {
    const describe = (t) => {
      const n = t.mustRead.length;
      const index = t.mustRead.some((e) => e && typeof e === "object" && e.index !== undefined);
      return `${t.id} (${n} ${n === 1 ? "entry" : "entries"}${index ? ", index" : ""})`;
    };
    lines.push(`must-read enforced: ${mustRead.map(describe).join(", ")} (transcript checked against mustRead; re-asks continue while the leaf closes lines, a shortfall is recorded, but a leaf that read none of its inputs fails)`);
  }
  // The author's own command: independent of returns and mustRead, which is why
  // a task carrying only `check` is announced here too.
  const checked = tasks.filter((t) => t.check?.length);
  if (checked.length) {
    lines.push(`output check: ${checked.map((t) => t.id).join(", ")} (the named command runs on the output; a rejection gets up to ${CONTRACT_CHECK_REASKS} corrective re-asks with the checker's own output, then fails the leaf — a broken or timed-out checker fails it at once)`);
  }
  return lines;
}
