import { readFileSync, existsSync, readdirSync } from "node:fs";
import { resolve, join, basename, sep } from "node:path";
import { swarmHome } from "./config.mjs";
import { isClaudeModel, isValidEffort, tierFromModel, TIER_EFFORTS } from "./models.mjs";
import { parseExpr, collectDepRefs, collectIdents } from "./expr.mjs";

export class ValidationError extends Error {
  constructor(errors) {
    super(`manifest validation failed:\n  - ${errors.join("\n  - ")}`);
    this.name = "ValidationError";
    this.errors = errors;
  }
}

// Default leaf toolset is read-only; write capability must be asked for.
export const DEFAULT_TOOLS = "Read,Grep,Glob";
const WRITE_TOOLS = new Set(["edit", "write", "bash", "notebookedit"]);

const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const TEMPLATE_RE = /\{\{(result|resultPath):([^}]*)\}\}/g;
const CLONE_ID_RE = /\[\d+\]$/;
const ITEM_TEMPLATE_RE = /\{\{(item(?:\.[^}]*)?|index)\}\}/;
const KNOWN_TASK_KEYS = new Set([
  "id", "prompt", "model", "fallbackModel", "effort", "allowedTools", "cwd",
  "isolation", "outputDir", "timeoutMs", "after", "compute", "when", "forEach",
]);

export function hasWriteTools(allowedTools) {
  return String(allowedTools || "")
    .split(",")
    .map((t) => t.trim().toLowerCase())
    .some((t) => WRITE_TOOLS.has(t));
}

function normalizeForCompare(p) {
  let n = resolve(p).replace(/[\\/]+/g, sep);
  if (n.length > 1 && (n.endsWith("\\") || n.endsWith("/"))) n = n.slice(0, -1);
  return process.platform === "win32" ? n.toLowerCase() : n;
}

// True when `dir` is `root` or lives underneath it (path-boundary aware).
export function isUnderRoot(dir, root) {
  const d = normalizeForCompare(dir);
  const r = normalizeForCompare(root);
  return d === r || d.startsWith(r + sep);
}

// Default resultsDir: ~/.swarm/runs/<encoded-cwd>/<manifest-stem>-<n> — run
// artefacts live in the user's home, never inside a code dir. Reuse the
// highest-numbered existing dir so a bare re-run resumes into the same run
// (resume skips ok results); first run gets -1. An explicit resultsDir in the
// manifest is always used verbatim (resolved against cwd).
function defaultResultsDir(manifestPath, cwd) {
  const stem = basename(manifestPath).replace(/\.json$/i, "");
  const base = join(swarmHome(), "runs", cwd.replace(/[\\/:]/g, "-"));
  let n = 0;
  if (existsSync(base)) {
    const re = new RegExp(`^${stem.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}-(\\d+)$`);
    for (const entry of readdirSync(base)) {
      const m = entry.match(re);
      if (m) n = Math.max(n, parseInt(m[1], 10));
    }
  }
  return join(base, `${stem}-${n || 1}`);
}

function detectCycle(tasks) {
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

// Load + validate a manifest into a normalized plan. Throws ValidationError
// listing every problem found. `cwd` is the invoking process's cwd — the
// default task cwd and the base for relative paths.
export function loadManifest(path, cfg, cwd = process.cwd()) {
  const errors = [];
  const manifestPath = resolve(cwd, path);
  let raw;
  try {
    raw = JSON.parse(readFileSync(manifestPath, "utf8"));
  } catch (e) {
    throw new ValidationError([`cannot read manifest ${manifestPath}: ${e.message}`]);
  }

  if (!Array.isArray(raw.tasks) || raw.tasks.length === 0) {
    throw new ValidationError(["manifest must contain a non-empty 'tasks' array"]);
  }

  const resultsDir = raw.resultsDir
    ? resolve(cwd, raw.resultsDir)
    : defaultResultsDir(manifestPath, cwd);

  const concurrency = raw.concurrency ?? cfg.concurrency ?? 4;
  if (!Number.isInteger(concurrency) || concurrency < 1) {
    errors.push(`concurrency must be a positive integer (got ${JSON.stringify(raw.concurrency)})`);
  }

  const seen = new Set();
  for (const t of raw.tasks) {
    const label = t?.id ? `task '${t.id}'` : "task with missing id";
    for (const k of Object.keys(t || {})) {
      if (!KNOWN_TASK_KEYS.has(k)) {
        errors.push(`${label}: unknown key '${k}' — known keys: ${[...KNOWN_TASK_KEYS].join(", ")}`);
      }
    }
    if (typeof t.id === "string" && CLONE_ID_RE.test(t.id)) {
      errors.push(`${label}: ids ending in [n] are reserved for forEach clones`);
    } else if (typeof t.id === "string" && t.id.startsWith("__")) {
      errors.push(`${label}: ids starting with '__' are reserved for engine-synthesized tasks`);
    } else if (!t.id || typeof t.id !== "string" || !ID_RE.test(t.id)) {
      errors.push(`${label}: id is required and must be filename-safe ([A-Za-z0-9._-], not starting with '.'/'-')`);
    } else if (seen.has(t.id)) {
      errors.push(`${label}: duplicate id`);
    }
    seen.add(t.id);
    if (t.compute !== undefined) {
      // Agentless: a compute step never spawns a leaf, so leaf-only keys are
      // authoring mistakes worth naming individually.
      const agentKeys = ["model", "prompt", "fallbackModel", "effort", "allowedTools", "isolation"]
        .filter((k) => t[k] !== undefined);
      if (agentKeys.length) {
        errors.push(`${label}: compute tasks are agentless — remove ${agentKeys.join("/")}; the expression runs in the engine, no leaf is spawned`);
      }
      if (t.forEach !== undefined) {
        errors.push(`${label}: a task cannot be both forEach and compute — compute the list in one step, forEach over it in the next`);
      }
    } else {
      if (!t.prompt || typeof t.prompt !== "string") errors.push(`${label}: prompt is required`);
      if (!t.model || typeof t.model !== "string") errors.push(`${label}: model is required`);
    }
    if (t.isolation !== undefined && t.isolation !== "worktree") {
      errors.push(`${label}: isolation must be "worktree" when present (got ${JSON.stringify(t.isolation)})`);
    }
    if (t.timeoutMs !== undefined && (!Number.isInteger(t.timeoutMs) || t.timeoutMs < 1)) {
      errors.push(`${label}: timeoutMs must be a positive integer`);
    }
  }

  const ids = new Set(raw.tasks.map((t) => t.id));
  for (const t of raw.tasks) {
    if (t.after !== undefined && !Array.isArray(t.after)) {
      errors.push(`task '${t.id}': after must be an array of task ids`);
      continue;
    }
    for (const dep of t.after || []) {
      if (!ids.has(dep)) errors.push(`task '${t.id}': unknown dependency '${dep}' in after`);
      if (dep === t.id) errors.push(`task '${t.id}': cannot depend on itself`);
    }
    // Template refs may only name declared dependencies — anything else can't
    // be guaranteed complete when the prompt is materialized.
    const deps = new Set(t.after || []);
    for (const m of String(t.prompt || "").matchAll(TEMPLATE_RE)) {
      if (!deps.has(m[2])) {
        errors.push(`task '${t.id}': template {{${m[1]}:${m[2]}}} references '${m[2]}' which is not a declared dependency in after`);
      }
    }
    if (t.compute === undefined && t.effort !== undefined && !isValidEffort(t.model, t.effort)) {
      const tier = tierFromModel(t.model);
      errors.push(`task '${t.id}': effort '${t.effort}' is not valid for ${tier} (allowed: ${TIER_EFFORTS[tier].join(", ")})`);
    }

    const label = `task '${t.id}'`;

    // {{item}}/{{index}} substitute at clone time — outside a forEach task they
    // would reach the leaf as literal braces, which is always an authoring bug.
    if (t.forEach === undefined && ITEM_TEMPLATE_RE.test(String(t.prompt || ""))) {
      errors.push(`${label}: {{item}}/{{index}} placeholders are only substituted in forEach tasks — add a forEach block or remove them`);
    }

    if (t.when !== undefined) {
      if (!t.when || typeof t.when !== "object" || Array.isArray(t.when)) {
        errors.push(`${label}: when must be an object — e.g. "when": {"from": "scan", "expr": "length(value) > 0"}`);
      } else {
        for (const k of Object.keys(t.when)) {
          if (k !== "from" && k !== "expr") {
            errors.push(`${label}: unknown key '${k}' in when — the shape is {"from": "<dep id>", "expr": "<expression over value>"}`);
          }
        }
        if (typeof t.when.from !== "string" || !t.when.from) {
          errors.push(`${label}: when.from is required — the dependency whose output gates this task; e.g. "when": {"from": "scan", "expr": "length(value) > 0"}`);
        } else if (!deps.has(t.when.from)) {
          errors.push(`${label}: when.from '${t.when.from}' must be a declared dependency — add '${t.when.from}' to after`);
        }
        if (typeof t.when.expr !== "string" || !t.when.expr) {
          errors.push(`${label}: when.expr is required — a boolean expression over value; e.g. "expr": "length(value) > 0"`);
        } else {
          try {
            parseExpr(t.when.expr);
            for (const name of collectIdents(t.when.expr)) {
              if (name === "deps") {
                errors.push(`${label}: a when expression reads only 'value' (the output of when.from) — deps[...] is available in compute expressions`);
              } else if (name !== "value" && name !== "item") {
                errors.push(`${label}: unknown identifier '${name}' in when.expr — available: value (the output of when.from), item (inside predicates)`);
              }
            }
          } catch (e) {
            errors.push(`${label}: when.expr — ${e.message}`);
          }
        }
      }
    }

    if (t.forEach !== undefined && t.compute === undefined) {
      if (!t.forEach || typeof t.forEach !== "object" || Array.isArray(t.forEach)) {
        errors.push(`${label}: forEach must be an object — e.g. "forEach": {"from": "dedupe", "path": "sites", "maxItems": 30}`);
      } else {
        for (const k of Object.keys(t.forEach)) {
          if (k !== "from" && k !== "path" && k !== "maxItems") {
            errors.push(`${label}: unknown key '${k}' in forEach — the shape is {"from": "<dep id>", "path": "<field of its JSON, '' for the value itself>", "maxItems": <cap>}`);
          }
        }
        if (typeof t.forEach.from !== "string" || !t.forEach.from) {
          errors.push(`${label}: forEach.from is required — the dependency whose JSON array this task maps over`);
        } else if (!deps.has(t.forEach.from)) {
          errors.push(`${label}: forEach.from '${t.forEach.from}' must be a declared dependency — add '${t.forEach.from}' to after`);
        }
        if (t.forEach.maxItems === undefined) {
          errors.push(`${label}: forEach.maxItems is required — the cap IS the run's approval (the preview must show a worst-case leaf count); e.g. "forEach": {"from": "dedupe", "maxItems": 30}`);
        } else if (!Number.isInteger(t.forEach.maxItems) || t.forEach.maxItems < 1) {
          errors.push(`${label}: forEach.maxItems must be a positive integer (got ${JSON.stringify(t.forEach.maxItems)})`);
        }
        if (t.forEach.path !== undefined && typeof t.forEach.path !== "string") {
          errors.push(`${label}: forEach.path must be a string field path into the source JSON ('' selects the value itself)`);
        }
      }
    }

    if (t.compute !== undefined) {
      if (typeof t.compute !== "string" || !t.compute) {
        errors.push(`${label}: compute must be a string expression — e.g. "compute": "unique_by(deps['scan'].sites, 'file')"`);
      } else {
        try {
          parseExpr(t.compute);
          const { refs, dynamic } = collectDepRefs(t.compute);
          if (dynamic) {
            errors.push(`${label}: deps must be accessed with a literal task id like deps['scan'] — computed keys can't be checked at validate time`);
          }
          for (const ref of refs) {
            if (!deps.has(ref)) {
              errors.push(`${label}: compute reads deps['${ref}'] but '${ref}' is not a declared dependency — add it to after`);
            }
          }
          for (const name of collectIdents(t.compute)) {
            if (name === "value") {
              errors.push(`${label}: 'value' is not available in compute — read dependencies via deps['id'] ('value' is the when-gate input)`);
            } else if (name !== "deps" && name !== "item") {
              errors.push(`${label}: unknown identifier '${name}' in compute — available: deps['id'] and item (inside predicates)`);
            }
          }
        } catch (e) {
          errors.push(`${label}: compute — ${e.message}`);
        }
      }
    }
  }

  const cycle = detectCycle(raw.tasks.filter((t) => t.id));
  if (cycle) errors.push(`dependency cycle detected: ${cycle.join(" -> ")}`);

  // Governance gate — deny-by-default for non-Claude models. The employer's
  // data agreement covers Anthropic only; open-model tasks may run only under
  // directories the user has explicitly allow-listed. Checked against the
  // task's ORIGINAL effective cwd (before any scratch redirect).
  const allowedRoots = cfg?.provider?.allowedRoots || [];
  const governanceCheck = (model, effCwd, label) => {
    if (isClaudeModel(model)) return;
    if (!allowedRoots.some((root) => isUnderRoot(effCwd, root))) {
      errors.push(
        `${label}: model '${model}' is not a Claude model and its cwd '${effCwd}' is not under any ` +
        `provider.allowedRoots entry — blocked by data governance policy (only Anthropic is covered ` +
        `by the data agreement). Configure provider.allowedRoots in ~/.swarm/config.json to permit open-model dispatch there.`
      );
    }
  };

  const tasks = raw.tasks.map((t) => {
    const isCompute = t.compute !== undefined;
    const originalCwd = t.cwd ? resolve(cwd, t.cwd) : cwd;
    // compute steps spawn nothing and no code leaves the machine — no
    // governance, no write-implies-isolation.
    if (!isCompute) {
      governanceCheck(t.model, originalCwd, `task '${t.id}'`);
      if (t.fallbackModel !== undefined) {
        if (typeof t.fallbackModel !== "string" || !t.fallbackModel) {
          errors.push(`task '${t.id}': fallbackModel must be a model name string`);
        } else {
          // the fallback is a real dispatch target — same governance as the primary
          governanceCheck(t.fallbackModel, originalCwd, `task '${t.id}' fallback`);
        }
      }
    }
    let effCwd = originalCwd;
    let scratchRedirect = false;
    // Write-implies-isolation: a leaf granted write-capable tools without
    // worktree isolation never runs in the user's real tree — its cwd is
    // redirected to a per-task scratch dir under the results dir.
    if (!isCompute && hasWriteTools(t.allowedTools) && t.isolation !== "worktree") {
      effCwd = join(resultsDir, `scratch-${t.id}`);
      scratchRedirect = true;
    }
    const whenBlock = t.when && typeof t.when === "object" && !Array.isArray(t.when)
      ? { when: { from: t.when.from, expr: t.when.expr } } : {};
    const forEachBlock = !isCompute && t.forEach && typeof t.forEach === "object" && !Array.isArray(t.forEach)
      ? { forEach: { from: t.forEach.from, path: t.forEach.path ?? "", maxItems: t.forEach.maxItems } } : {};
    return {
      id: t.id,
      prompt: isCompute ? "" : t.prompt,
      // "compute" is a display sentinel, never dispatched — compute steps run
      // inline in the engine (the scheduler excludes them from preflights).
      model: isCompute ? "compute" : t.model,
      fallbackModel: !isCompute && typeof t.fallbackModel === "string" ? t.fallbackModel : undefined,
      effort: isCompute ? undefined : t.effort,
      allowedTools: isCompute ? "" : t.allowedTools || DEFAULT_TOOLS,
      cwd: effCwd,
      originalCwd,
      scratchRedirect,
      isolation: isCompute ? undefined : t.isolation,
      outputDir: t.outputDir ? resolve(cwd, t.outputDir) : undefined,
      timeoutMs: t.timeoutMs ?? raw.timeoutMs ?? cfg.timeoutMs ?? 600000,
      after: [...(t.after || [])],
      ...(isCompute && { compute: t.compute }),
      ...whenBlock,
      ...forEachBlock,
    };
  });

  let digest;
  if (raw.digest !== undefined) {
    if (!raw.digest || typeof raw.digest !== "object" || !raw.digest.model) {
      errors.push("digest block must be an object with a 'model'");
    } else {
      governanceCheck(raw.digest.model, cwd, "digest");
      digest = { model: raw.digest.model, instructions: raw.digest.instructions || "" };
    }
  }

  if (errors.length) throw new ValidationError(errors);

  return {
    path: manifestPath,
    cwd,
    resultsDir,
    concurrency,
    tasks,
    digest,
    goal: raw.goal || "",
  };
}
