// The agentless step kinds: dependency readiness, when/compute evaluation,
// integrate, forEach and manifest expansion, and the aggregate that folds clones.
import { readResult, writeResult, appendRunLog } from "../results.mjs";
import { evalBool, evalExpr } from "../expr.mjs";
import { writeTaskResult, cacheHit, pinKey } from "../task-key.mjs";
import { cloneId, childId, ALIVE_STATES } from "../runlog.mjs";
import { TEMPLATE_RE } from "../coverage.mjs";
import { substituteTemplates, substituteItems } from "./run-task.mjs";

const OK_STATES = new Set(["ok", "skipped"]);

export function createDeterministicSteps(ctx) {
  const { cfg, io, plan, tasks } = ctx;

  const depsSatisfied = (t) => t.after.every((d) => OK_STATES.has(ctx.state.get(d)));
  const depsDoomed = (t) => t.after.some((d) => {
    const s = ctx.state.get(d);
    return s !== undefined && !OK_STATES.has(s) && !ALIVE_STATES.has(s);
  });

  // A dependency's value for expressions and forEach: parsed JSON when the
  // leaf produced any, else the raw output string.
  const valueOf = (id) => {
    const res = readResult(plan.resultsDir, id);
    if (!res) return null;
    return res.outputJson !== undefined ? res.outputJson : String(res.output ?? "");
  };
  const typeOf = (v) => (v === null ? "null" : Array.isArray(v) ? "array" : typeof v);
  const digPath = (v, path) => {
    if (!path) return v;
    let cur = v;
    for (const seg of path.split(".")) {
      cur = cur !== null && typeof cur === "object" && !Array.isArray(cur) && Object.hasOwn(cur, seg) ? cur[seg] : undefined;
      if (cur === undefined) return undefined;
    }
    return cur;
  };
  // Both truncation paths share one loud channel: run.log event, stdout warning,
  // run-summary field, closing block. A cut only the engine knows about is how an
  // unverified finding ends up reported as verified.
  const notePromptTruncations = (task, list) => {
    for (const t of list) {
      ctx.truncations.push({ kind: "prompt", id: task.id, depId: t.depId, kept: t.kept, total: t.total });
      appendRunLog(plan.resultsDir, {
        ts: new Date().toISOString(), event: "truncate-prompt", id: task.id,
        depId: t.depId, kept: t.kept, total: t.total,
      });
      io.stdout(`⚠ ${task.id}: {{result:${t.depId}}} inlined ${t.kept} of ${t.total} chars — the rest was NOT seen; use {{resultPath:${t.depId}}} to pass the whole result`);
    }
  };

  // Evaluate a task's when-gate once its deps are satisfied. True ⇒ proceed;
  // false ⇒ the task settled here (skipped, or failed on an expression error).
  // Skips write no result file — a when re-evaluates deterministically on resume.
  const passesWhen = (task) => {
    if (!task.when) return true;
    let pass;
    try {
      pass = evalBool(task.when.expr, { value: valueOf(task.when.from) });
    } catch (e) {
      writeResult(plan.resultsDir, task.id, { id: task.id, model: task.model, ...ctx.durableIdentity(task), ok: false, exit: null, durationMs: 0, output: `when failed: ${e.message}` });
      ctx.record(task, "failed", 0);
      return false;
    }
    if (pass) return true;
    ctx.record(task, "skipped", null, undefined, `when: ${task.when.expr} → false`);
    return false;
  };

  // compute steps run inline — no spawn, no slot, zero tokens. The result is a
  // first-class task result so {{result:}} and forEach.from consume it as usual.
  // Spliced child computes bind deps by their LOCAL ids via depAliases — the
  // expression text is never rewritten.
  const runCompute = (task) => {
    ctx.record(task, "running");
    const t0 = io.now();
    let result;
    try {
      const scope = { deps: task.depAliases
        ? Object.fromEntries(Object.entries(task.depAliases).map(([local, full]) => [local, valueOf(full)]))
        : Object.fromEntries(task.after.map((d) => [d, valueOf(d)])) };
      const v = evalExpr(task.compute, scope);
      result = {
        id: task.id, model: task.model, ...ctx.durableIdentity(task), ok: true, exit: 0, durationMs: io.now() - t0,
        output: typeof v === "string" ? v : JSON.stringify(v),
        outputJson: v,
      };
    } catch (e) {
      result = { id: task.id, model: task.model, ...ctx.durableIdentity(task), ok: false, exit: null, durationMs: io.now() - t0, output: `compute failed: ${e.message}` };
    }
    writeTaskResult(plan.resultsDir, task, result);
    ctx.record(task, result.ok ? "ok" : "failed", result.durationMs);
  };

  // Agentless merge: fold the named tasks' branches into the target worktree.
  // A conflict is NOT a failure — the markers stay in the tree and the paths are
  // reported, because the next link is a model that can read and resolve them.
  const runIntegrate = (task) => {
    ctx.record(task, "running");
    const t0 = io.now();
    let result;
    try {
      const sources = ctx.resolveIntegrateFrom(task.integrate.from).map(ctx.branchOf);
      const out = ctx.worktree.integrate(
        { ...task, worktreeName: task.integrate.into, sources }, cfg, plan.resultsDir,
        { repo: task.originalCwd || plan.cwd, base: ctx.baseFor(task.originalCwd || plan.cwd) });
      const payload = { into: task.integrate.into, branch: out.branch, merged: out.merged, conflicts: out.conflicts };
      result = {
        id: task.id, model: task.model, ...ctx.durableIdentity(task), ok: true, exit: 0, durationMs: io.now() - t0,
        output: out.conflicts.length
          ? `merged ${out.merged.join(", ")} into ${out.branch}; conflicts left in the tree for the next leaf to resolve: ${out.conflicts.join(", ")}`
          : `merged ${out.merged.join(", ")} into ${out.branch} cleanly`,
        outputJson: payload,
      };
      appendRunLog(plan.resultsDir, {
        ts: new Date().toISOString(), event: "integrate", id: task.id,
        into: task.integrate.into, merged: out.merged.length, conflicts: out.conflicts.length,
      });
    } catch (e) {
      result = { id: task.id, model: task.model, ...ctx.durableIdentity(task), ok: false, exit: null, durationMs: io.now() - t0, output: `integrate failed: ${e.message}` };
    }
    writeTaskResult(plan.resultsDir, task, result);
    ctx.record(task, result.ok ? "ok" : "failed", result.durationMs);
  };

  // Expansion morphs the parent into a pending aggregate over its clones, so
  // dependents keep depending on the parent id. Both template passes run here;
  // promptFinal stops the launch-time pass from re-scanning substituted data.
  const expandForEach = (task) => {
    const src = valueOf(task.forEach.from);
    const sel = digPath(src, task.forEach.path);
    if (!Array.isArray(sel)) {
      const where = task.forEach.path ? `'${task.forEach.from}'.${task.forEach.path}` : `'${task.forEach.from}'`;
      writeResult(plan.resultsDir, task.id, {
        id: task.id, model: task.model, ...ctx.durableIdentity(task), ok: false, exit: null, durationMs: 0,
        output: `forEach failed: ${where} is ${typeOf(sel === undefined ? null : sel)} — expected a JSON array (check forEach.path against the dependency's output)`,
      });
      ctx.record(task, "failed", 0);
      return;
    }
    const items = sel.slice(0, task.forEach.maxItems);
    const truncated = sel.length > items.length;
    // A childPlan parent clones manifest NODES (one child copy per item —
    // {{item}} substitutes at each clone's own expansion); a plain parent
    // clones prompt leaves as before.
    let base = "";
    if (!task.childPlan) {
      const sub = substituteTemplates(task.prompt, plan.resultsDir, cfg.resultInlineCap ?? 4000);
      base = sub.prompt;
      notePromptTruncations(task, sub.truncations); // every clone inherits the cut base
    }
    const clones = items.map((item, i) => ({
      ...task,
      id: cloneId(task.id, i),
      // Clones run concurrently, so each needs its OWN tree — inheriting the
      // parent's name would put every clone in one directory. A shared name is
      // rejected at validation; the private shorthand lands here. Dash, not
      // the id's own `[i]` bracket — brackets are invalid in a git ref, and
      // this name feeds branchNameFor() straight into `git worktree add`.
      ...(task.worktreeName !== undefined && { worktreeName: `${task.id}-${i}` }),
      ...(task.childPlan
        ? { manifestItem: item, manifestIndex: i }
        : { prompt: substituteItems(base, item, i), promptFinal: true }),
      when: undefined,
      forEach: undefined,
      after: [...task.after],
    }));
    appendRunLog(plan.resultsDir, {
      ts: new Date().toISOString(), event: "expand", id: task.id, model: task.model, ...ctx.durableIdentity(task),
      clones: clones.length, ...(truncated && { truncated: true, total: sel.length }),
    });
    if (truncated) {
      ctx.truncations.push({ kind: "forEach", id: task.id, kept: items.length, total: sel.length });
      io.stdout(`⚠ ${task.id}: forEach source has ${sel.length} items — running the first ${items.length} (maxItems); raise maxItems to cover the rest`);
    }
    tasks.splice(tasks.indexOf(task) + 1, 0, ...clones);
    for (const c of clones) {
      ctx.state.set(c.id, "pending");
      if (!ctx.force) {
        const prior = readResult(plan.resultsDir, c.id);
        if (cacheHit(plan.resultsDir, c, prior)) ctx.record(c, "skipped", prior.durationMs ?? null, prior.tokens);
      }
    }
    task.waveAfter ??= [...task.after];
    pinKey(task); task.when = undefined;
    task.forEach = undefined;
    task.childPlan = undefined; // the clones carry it; the parent is now pure aggregate
    task.after = clones.map((c) => c.id);
    task.aggregate = { truncated, kept: items.length, total: sel.length };
    ctx.rebuildGroups();
    ctx.paint();
  };

  // Splice a manifest node's child tasks into the run under `<node>~<local>`
  // ids, remapping within-child references; the node morphs into an aggregate
  // over the child's sinks (tasks with no within-child dependents).
  const expandManifest = (node) => {
    const locals = new Set(node.childPlan.tasks.map((c) => c.id));
    const remap = (id) => childId(node.id, id);
    const hasItem = node.manifestItem !== undefined;
    const upstream = node.waveAfter || [...node.after]; // the node's own wave edge, kept for its root children
    // {{result:local}} / {{resultPath:local}} references to sibling child tasks are
    // rewritten to the spliced ids — in the prompt AND in each mustRead entry's
    // path/index string, so a verifier's `mustRead: ["{{resultPath:finder}}"]`
    // resolves to the remapped id at check time.
    const remapRefs = (s) => s.replace(TEMPLATE_RE, (whole, kind, id) => (locals.has(id) ? `{{${kind}:${remap(id)}}}` : whole));
    const remapMustRead = (entries) => entries.map((e) =>
      typeof e === "string" ? remapRefs(e)
      : e && typeof e === "object" ? {
          ...e,
          ...(typeof e.path === "string" && { path: remapRefs(e.path) }),
          ...(typeof e.index === "string" && { index: remapRefs(e.index) }),
        }
      : e);
    const spliced = node.childPlan.tasks.map((c) => {
      let prompt = remapRefs(c.prompt);
      // a child task with its own forEach keeps its {{item}} for its own clones
      if (hasItem && c.forEach === undefined) prompt = substituteItems(prompt, node.manifestItem, node.manifestIndex);
      return {
        ...c,
        id: remap(c.id),
        prompt,
        ...(Array.isArray(c.mustRead) && { mustRead: remapMustRead(c.mustRead) }),
        // Worktree names are remapped with the ids: two nodes splicing the same
        // child would otherwise resolve to one path, and an un-remapped name is
        // absent from the group maps entirely (never collected, never reset).
        ...(c.worktreeName !== undefined && { worktreeName: remap(c.worktreeName) }),
        after: c.after.map((d) => (locals.has(d) ? remap(d) : d)),
        ...(c.after.length === 0 && { waveAfter: upstream }),
        ...(c.when && { when: { ...c.when, from: locals.has(c.when.from) ? remap(c.when.from) : c.when.from } }),
        ...(c.forEach && { forEach: { ...c.forEach, from: locals.has(c.forEach.from) ? remap(c.forEach.from) : c.forEach.from } }),
        ...(c.compute !== undefined && {
          depAliases: Object.fromEntries(c.after.map((d) => [d, locals.has(d) ? remap(d) : d])),
        }),
      };
    });
    appendRunLog(plan.resultsDir, {
      ts: new Date().toISOString(), event: "expand-manifest", id: node.id,
      ...ctx.durableIdentity(node),
      children: spliced.map((c) => ({ id: c.id, model: c.model, ...ctx.durableIdentity(c) })),
    });
    tasks.splice(tasks.indexOf(node) + 1, 0, ...spliced);
    for (const c of spliced) {
      ctx.state.set(c.id, "pending");
      if (!ctx.force) {
        const prior = readResult(plan.resultsDir, c.id);
        if (cacheHit(plan.resultsDir, c, prior)) ctx.record(c, "skipped", prior.durationMs ?? null, prior.tokens);
      }
    }
    const dependedOn = new Set(node.childPlan.tasks.flatMap((c) => c.after.filter((d) => locals.has(d))));
    const sinks = node.childPlan.tasks.filter((c) => !dependedOn.has(c.id)).map((c) => ({ local: c.id, full: remap(c.id) }));
    pinKey(node); node.when = undefined;
    node.childPlan = undefined;
    node.waveAfter = upstream;
    node.after = spliced.map((c) => c.id);
    node.aggregateManifest = { sinks };
    ctx.rebuildGroups();
    ctx.paint();
  };

  const runManifestAggregate = (task) => {
    const outputJson = Object.fromEntries(task.aggregateManifest.sinks.map(({ local, full }) => [local, valueOf(full)]));
    const result = {
      id: task.id, model: task.model, ...ctx.durableIdentity(task), ok: true, exit: 0, durationMs: 0,
      output: JSON.stringify(outputJson), outputJson, children: task.after.length,
    };
    writeTaskResult(plan.resultsDir, task, result);
    ctx.record(task, "ok", 0);
  };

  const runAggregate = (task) => {
    const outs = task.after.map((cid) => {
      const r = readResult(plan.resultsDir, cid);
      return r && r.outputJson !== undefined ? r.outputJson : String(r?.output ?? "");
    });
    const result = {
      id: task.id, model: task.model, ...ctx.durableIdentity(task), ok: true, exit: 0, durationMs: 0,
      output: JSON.stringify(outs), outputJson: outs,
      clones: task.after.length,
      ...(task.aggregate.truncated && { truncated: { kept: task.aggregate.kept, total: task.aggregate.total } }),
    };
    writeTaskResult(plan.resultsDir, task, result);
    ctx.record(task, "ok", 0);
  };

  return {
    depsSatisfied, depsDoomed, valueOf, typeOf, digPath, notePromptTruncations,
    passesWhen, runCompute, runIntegrate, expandForEach, expandManifest,
    runManifestAggregate, runAggregate,
  };
}
