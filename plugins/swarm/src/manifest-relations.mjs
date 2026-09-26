// The edges between tasks: `after` dependency cycles and reachability, template
// and gate references, and the shared-worktree ordering rules those edges imply.

import { parseExpr, collectDepRefs, collectIdents } from "./expr.mjs";
import { validateSchemaShape } from "./schema.mjs";
import { TEMPLATE_RE } from "./coverage.mjs";
import { resolveWorktreeName, isSharedTree } from "./manifest-task-policy.mjs";

// {{item}}/{{index}} substitute at clone time — the two places that care are a
// forEach task's own validation and the worst-case prompt measurement.
export const ITEM_TEMPLATE_RE = /\{\{(item(?:\.[^}]*)?|index)\}\}/;
export const ITEM_TEMPLATE_RE_G = new RegExp(ITEM_TEMPLATE_RE.source, "g");

export function detectCycle(tasks) {
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const state = new Map(); // 0 visiting, 1 done
  const stack = [];
  function visit(id) {
    if (state.get(id) === 1) return null;
    if (state.get(id) === 0) return [...stack, id];
    state.set(id, 0);
    stack.push(id);
    for (const dep of byId.get(id)?.after || []) {
      if (!byId.has(dep)) continue; // unknown deps reported separately
      const cyc = visit(dep);
      if (cyc) return cyc;
    }
    stack.pop();
    state.set(id, 1);
    return null;
  }
  for (const t of tasks) {
    const cyc = visit(t.id);
    if (cyc) return cyc;
  }
  return null;
}

// Transitive `after` reachability over a task list. Exported because the
// scheduler must group worktrees by the SAME edges validation accepted them on —
// two copies of this walk is how the two drift into disagreeing about which task
// collects a tree.
export function makeReaches(tasks) {
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const reaches = (fromId, toId, seen = new Set()) => {
    if (fromId === toId) return true;
    if (seen.has(fromId)) return false;
    seen.add(fromId);
    const after = byId.get(fromId)?.after;
    return Array.isArray(after) && after.some((a) => reaches(a, toId, seen));
  };
  return reaches;
}

export function validateWorktreeGroups(rawTasks, errors, label) {
  const groups = new Map();
  for (const t of rawTasks) {
    const n = resolveWorktreeName(t);
    if (typeof n !== "string" || !n) continue;
    if (!groups.has(n)) groups.set(n, []);
    groups.get(n).push(t);
  }

  // Reachability over `after`, the same edges detectCycle walks.
  const reaches = makeReaches(rawTasks);

  for (const [name, members] of groups) {
    const shared = members.filter(isSharedTree);

    for (const t of shared) {
      if (t.forEach !== undefined) {
        errors.push(
          `${label(t)}: a forEach task cannot name the shared workspace "${name}" — clones run ` +
          `concurrently and would collide in one directory.\n` +
          `    Drop "workspace" and each clone gets its own tree.`);
      }
    }

    for (let i = 0; i < members.length; i++) {
      for (let j = i + 1; j < members.length; j++) {
        const [a, b] = [members[i], members[j]];
        if (reaches(a.id, b.id) || reaches(b.id, a.id)) continue;
        errors.push(
          `tasks '${a.id}' and '${b.id}' share workspace "${name}" but neither runs before the other.\n` +
          `    Tasks sharing a workspace must form a single ordered chain — add the missing\n` +
          `    \`after\` so one waits for the other:\n` +
          `        { "id": "${b.id}", "after": ["${a.id}"], "workspace": "${name}", … }`);
      }
    }

    // One directory cannot hold two branches: a link naming `branch` beside siblings
    // taking the derived one dies at `worktree add`, after the first committed.
    const branches = new Set(shared.map((t) => t.branch ?? null));
    if (branches.size > 1) {
      const named = shared.find((t) => t.branch);
      errors.push(
        `tasks sharing workspace "${name}" disagree on their branch: ` +
        shared.map((t) => `'${t.id}' → ${t.branch ? `"${t.branch}"` : "(derived)"}`).join(", ") + `.\n` +
        `    Every link of a shared workspace runs in ONE directory on ONE branch.\n` +
        `    Give them all the same branch, or drop it from all of them:\n` +
        `        "workspace": "${name}", "branch": "${named.branch}"`);
    }

    // A shared name equal to another task's id resolves to the same wt-<name> path.
    if (!shared.length) continue;
    const clash = members.find((t) => t.id === name && !isSharedTree(t));
    if (clash) {
      errors.push(
        `shared worktree "${name}" collides with task '${clash.id}', which has its own private ` +
        `worktree of the same name — both resolve to wt-${name}. Rename one.`);
    }
  }

  // A forEach task's clones don't exist yet at validation time, but
  // expandForEach (scheduler.mjs) will mint each one's worktree as
  // `${id}-${i}` once it runs — the same filename-safe charset a real task's
  // own worktree name is allowed to use. Catch the collision now, since no
  // separator can be reserved against an author's own choice.
  for (const t of rawTasks) {
    if (t.forEach === undefined || resolveWorktreeName(t) === undefined) continue;
    const maxItems = t.forEach.maxItems;
    if (!Number.isInteger(maxItems) || maxItems < 1) continue;
    for (let i = 0; i < maxItems; i++) {
      const cloneName = `${t.id}-${i}`;
      const clash = rawTasks.find((o) => o !== t && resolveWorktreeName(o) === cloneName);
      if (clash) {
        errors.push(
          `${label(t)}: forEach clone worktree "${cloneName}" would collide with task '${clash.id}', ` +
          `which already resolves to that same worktree name — rename '${clash.id}''s worktree.`);
      }
    }
  }
}

// `itemAllowed`: child tasks under a forEach parent node may read {{item}}
// even without their own forEach — the parent substitutes at clone time.
export function validateTaskRelations(rawTasks, errors, label, { itemAllowed = false } = {}) {
  const ids = new Set(rawTasks.map((t) => t.id));
  for (const t of rawTasks) {
    const l = label(t);
    if (t.after !== undefined && !Array.isArray(t.after)) {
      errors.push(`${l}: after must be an array of task ids`);
      continue;
    }
    for (const dep of t.after || []) {
      if (!ids.has(dep)) errors.push(`${l}: unknown dependency '${dep}' in after`);
      if (dep === t.id) errors.push(`${l}: cannot depend on itself`);
    }
    // Template refs may only name declared dependencies — anything else can't
    // be guaranteed complete when the prompt is materialized.
    const deps = new Set(t.after || []);
    for (const m of String(t.prompt || "").matchAll(TEMPLATE_RE)) {
      if (!deps.has(m[2])) {
        errors.push(`${l}: template {{${m[1]}:${m[2]}}} references '${m[2]}' which is not a declared dependency in after`);
      }
    }
    // {{item}}/{{index}} substitute at clone time — outside a forEach task they
    // would reach the leaf as literal braces, which is always an authoring bug.
    if (t.forEach === undefined && !itemAllowed && ITEM_TEMPLATE_RE.test(String(t.prompt || ""))) {
      errors.push(`${l}: {{item}}/{{index}} placeholders are only substituted in forEach tasks — add a forEach block or remove them`);
    }

    if (t.when !== undefined) {
      if (!t.when || typeof t.when !== "object" || Array.isArray(t.when)) {
        errors.push(`${l}: when must be an object — e.g. "when": {"from": "scan", "expr": "length(value) > 0"}`);
      } else {
        for (const k of Object.keys(t.when)) {
          if (k !== "from" && k !== "expr") {
            errors.push(`${l}: unknown key '${k}' in when — the shape is {"from": "<dep id>", "expr": "<expression over value>"}`);
          }
        }
        if (typeof t.when.from !== "string" || !t.when.from) {
          errors.push(`${l}: when.from is required — the dependency whose output gates this task; e.g. "when": {"from": "scan", "expr": "length(value) > 0"}`);
        } else if (!deps.has(t.when.from)) {
          errors.push(`${l}: when.from '${t.when.from}' must be a declared dependency — add '${t.when.from}' to after`);
        }
        if (typeof t.when.expr !== "string" || !t.when.expr) {
          errors.push(`${l}: when.expr is required — a boolean expression over value; e.g. "expr": "length(value) > 0"`);
        } else {
          try {
            parseExpr(t.when.expr);
            for (const name of collectIdents(t.when.expr)) {
              if (name === "deps") {
                errors.push(`${l}: a when expression reads only 'value' (the output of when.from) — deps[...] is available in compute expressions`);
              } else if (name !== "value" && name !== "item") {
                errors.push(`${l}: unknown identifier '${name}' in when.expr — available: value (the output of when.from), item (inside predicates)`);
              }
            }
          } catch (e) {
            errors.push(`${l}: when.expr — ${e.message}`);
          }
        }
      }
    }

    if (t.forEach !== undefined && t.compute === undefined) {
      if (!t.forEach || typeof t.forEach !== "object" || Array.isArray(t.forEach)) {
        errors.push(`${l}: forEach must be an object — e.g. "forEach": {"from": "dedupe", "path": "sites", "maxItems": 30}`);
      } else {
        for (const k of Object.keys(t.forEach)) {
          if (k !== "from" && k !== "path" && k !== "maxItems") {
            errors.push(`${l}: unknown key '${k}' in forEach — the shape is {"from": "<dep id>", "path": "<field of its JSON, '' for the value itself>", "maxItems": <cap>}`);
          }
        }
        if (typeof t.forEach.from !== "string" || !t.forEach.from) {
          errors.push(`${l}: forEach.from is required — the dependency whose JSON array this task maps over`);
        } else if (!deps.has(t.forEach.from)) {
          errors.push(`${l}: forEach.from '${t.forEach.from}' must be a declared dependency — add '${t.forEach.from}' to after`);
        }
        if (t.forEach.maxItems === undefined) {
          errors.push(`${l}: forEach.maxItems is required — the cap IS the run's approval (the preview must show a worst-case leaf count); e.g. "forEach": {"from": "dedupe", "maxItems": 30}`);
        } else if (!Number.isInteger(t.forEach.maxItems) || t.forEach.maxItems < 1) {
          errors.push(`${l}: forEach.maxItems must be a positive integer (got ${JSON.stringify(t.forEach.maxItems)})`);
        }
        if (t.forEach.path !== undefined && typeof t.forEach.path !== "string") {
          errors.push(`${l}: forEach.path must be a string field path into the source JSON ('' selects the value itself)`);
        }
      }
    }

    if (t.compute !== undefined && t.manifest === undefined) {
      if (typeof t.compute !== "string" || !t.compute) {
        errors.push(`${l}: compute must be a string expression — e.g. "compute": "unique_by(deps['scan'].sites, 'file')"`);
      } else {
        try {
          parseExpr(t.compute);
          const { refs, dynamic } = collectDepRefs(t.compute);
          if (dynamic) {
            errors.push(`${l}: deps must be accessed with a literal task id like deps['scan'] — computed keys can't be checked at validate time`);
          }
          for (const ref of refs) {
            if (!deps.has(ref)) {
              errors.push(`${l}: compute reads deps['${ref}'] but '${ref}' is not a declared dependency — add it to after`);
            }
          }
          for (const name of collectIdents(t.compute)) {
            if (name === "value") {
              errors.push(`${l}: 'value' is not available in compute — read dependencies via deps['id'] ('value' is the when-gate input)`);
            } else if (name !== "deps" && name !== "item") {
              errors.push(`${l}: unknown identifier '${name}' in compute — available: deps['id'] and item (inside predicates)`);
            }
          }
        } catch (e) {
          errors.push(`${l}: compute — ${e.message}`);
        }
      }
    }

    if (t.returns !== undefined && t.manifest === undefined) {
      if (t.compute !== undefined) {
        // compute output is a pure function of its inputs — a wrong shape
        // there means the expression is wrong, not the data.
        errors.push(`${l}: compute output is engine-deterministic — put 'returns' on the leaf task that produces the data`);
      } else {
        errors.push(...validateSchemaShape(t.returns).map((e) => `${l}: ${e}`));
      }
    }

    // Every branch an integrate node merges must exist by the time it runs, and
    // must actually be a branch. `integrate` is now the ONLY way to seed a tree from
    // another task's commits — `isolation.from` is gone, so a branch-and-rejoin shape
    // seeds each private tree with its own integrate node.
    if (t.integrate && typeof t.integrate === "object" && Array.isArray(t.integrate.from)) {
      for (const srcId of t.integrate.from) {
        if (typeof srcId !== "string" || !srcId) {
          errors.push(`${l}: integrate.from entries must be task ids`);
        } else if (!deps.has(srcId)) {
          errors.push(`${l}: integrate.from '${srcId}' must be a declared dependency — add '${srcId}' to after, or its branch may not exist when the merge runs`);
        } else {
          const src = rawTasks.find((o) => o.id === srcId);
          if (src && resolveWorktreeName(src) === undefined) {
            errors.push(
              `${l}: integrate.from '${srcId}' has no write tools, so it commits nothing and owns no ` +
              `branch to merge — merge the tasks that WRITE, and pass '${srcId}' findings to a leaf ` +
              `with {{result:${srcId}}} instead`);
          } else if (src && src.when !== undefined) {
            errors.push(
              `${l}: integrate.from '${srcId}' is when-gated — if its gate is false it is skipped ` +
              `before its worktree exists, so there may be no branch to merge. Merge an ` +
              `unconditional task, or move the gate onto this node too`);
          }
        }
      }
    }

    if (t.verifyCitations !== undefined && typeof t.verifyCitations !== "boolean") {
      errors.push(`${l}: verifyCitations must be true or false (got ${JSON.stringify(t.verifyCitations)}) — citation-shaped returns are verified by default; false opts out`);
    }
  }
}
