import { readFileSync, existsSync, readdirSync } from "node:fs";
import { resolve, join, basename, dirname, sep } from "node:path";
import { createHash } from "node:crypto";
import { swarmHome, DEFAULT_TIMEOUT_MS } from "./config.mjs";
import { isClaudeModel, isValidEffort, tierFromModel, TIER_EFFORTS } from "./models.mjs";
import { parseExpr, collectDepRefs, collectIdents } from "./expr.mjs";
import { validateSchemaShape } from "./schema.mjs";

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
  "returns", "verifyCitations", "manifest",
]);
// A manifest task is an agentless container for its child's tasks — every
// leaf-shaped key on the node itself is an authoring mistake.
const MANIFEST_BANNED_KEYS = [
  "prompt", "model", "compute", "returns", "isolation", "allowedTools",
  "outputDir", "effort", "fallbackModel",
];

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

// ── args parameterization ({{args.<key>}}) ────────────────────────────────────
// Substituted on RAW text before any validation, so the validators — and the
// gate preview — see the final prompts. Values render like substituteItems:
// strings raw, everything else JSON. An unknown key never becomes an empty
// string in a prompt; it stays literal and fails validation.

const ARGS_TEMPLATE_RE = /\{\{args\.([A-Za-z0-9_]+)\}\}/g;

function renderArg(v) {
  return typeof v === "string" ? v : JSON.stringify(v);
}

// Substitute into every task prompt of a raw manifest (parent or child).
// Known keys are recorded in `used`; unknown keys produce a labelled error.
function applyArgsToRawTasks(rawTasks, args, used, errors, label) {
  for (const t of rawTasks) {
    if (!t || typeof t !== "object" || typeof t.prompt !== "string") continue;
    t.prompt = t.prompt.replace(ARGS_TEMPLATE_RE, (whole, key) => {
      if (args && Object.hasOwn(args, key)) {
        used.add(key);
        return renderArg(args[key]);
      }
      const supplied = args && Object.keys(args).length ? Object.keys(args).join(", ") : "(none)";
      errors.push(`${label(t)}: {{args.${key}}} has no supplied value — supplied keys: ${supplied}; pass --args '{"${key}": "…"}'`);
      return whole;
    });
  }
}

// Key-order-independent fingerprint so `run <name> --args …` keys its own
// default results dir: same args resume, different args never cross-resume.
function canonicalize(v) {
  if (Array.isArray(v)) return v.map(canonicalize);
  if (v !== null && typeof v === "object") {
    return Object.fromEntries(Object.keys(v).sort().map((k) => [k, canonicalize(v[k])]));
  }
  return v;
}

export function argsFingerprint(args) {
  if (!args || !Object.keys(args).length) return undefined;
  return createHash("sha1").update(JSON.stringify(canonicalize(args))).digest("hex").slice(0, 8);
}

// Default resultsDir: ~/.swarm/runs/<encoded-cwd>/<manifest-stem>-<n> — run
// artefacts live in the user's home, never inside a code dir. Reuse the
// highest-numbered existing dir so a bare re-run resumes into the same run
// (resume skips ok results); first run gets -1. An explicit resultsDir in the
// manifest is always used verbatim (resolved against cwd). With --args the
// stem carries the args fingerprint — a differently-parameterized run must
// never resume into another parameterization's dir.
function defaultResultsDir(manifestPath, cwd, argsFp) {
  const stem = basename(manifestPath).replace(/\.json$/i, "") + (argsFp ? `.${argsFp}` : "");
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

// Fence-tolerant JSON read — manifests may be model-authored, and models fence
// JSON in markdown; extend the same tolerance the engine gives leaf output.
// Exported for the registry's goal peek — one tolerance rule, not two.
export function readManifestJson(path) {
  const text = readFileSync(path, "utf8");
  const fenced = text.match(/^\s*```(?:json)?\s*([\s\S]*?)```\s*$/);
  return JSON.parse(fenced ? fenced[1] : text);
}

// ── shared per-task validation ────────────────────────────────────────────────
// One rule set for parent and child task lists. `label(t)` renders the error
// prefix — child errors read "task 'audit' -> child 'scan': …".

function validateTaskShapes(rawTasks, errors, label) {
  const seen = new Set();
  for (const t of rawTasks) {
    const l = label(t);
    for (const k of Object.keys(t || {})) {
      if (!KNOWN_TASK_KEYS.has(k)) {
        errors.push(`${l}: unknown key '${k}' — known keys: ${[...KNOWN_TASK_KEYS].join(", ")}`);
      }
    }
    if (typeof t.id === "string" && CLONE_ID_RE.test(t.id)) {
      errors.push(`${l}: ids ending in [n] are reserved for forEach clones`);
    } else if (typeof t.id === "string" && t.id.startsWith("__")) {
      errors.push(`${l}: ids starting with '__' are reserved for engine-synthesized tasks`);
    } else if (!t.id || typeof t.id !== "string" || !ID_RE.test(t.id)) {
      errors.push(`${l}: id is required and must be filename-safe ([A-Za-z0-9._-], not starting with '.'/'-')`);
    } else if (seen.has(t.id)) {
      errors.push(`${l}: duplicate id`);
    }
    seen.add(t.id);
    if (t.manifest !== undefined) {
      if (typeof t.manifest !== "string" || !t.manifest) {
        errors.push(`${l}: manifest must be a path string — e.g. "manifest": "audit-one-repo.json"`);
      }
      const banned = MANIFEST_BANNED_KEYS.filter((k) => t[k] !== undefined);
      for (const k of banned) {
        errors.push(`${l}: the manifest task is an agentless container — ${k} belongs on the child's own tasks`);
      }
    } else if (t.compute !== undefined) {
      // Agentless: a compute step never spawns a leaf, so leaf-only keys are
      // authoring mistakes worth naming individually.
      const agentKeys = ["model", "prompt", "fallbackModel", "effort", "allowedTools", "isolation"]
        .filter((k) => t[k] !== undefined);
      if (agentKeys.length) {
        errors.push(`${l}: compute tasks are agentless — remove ${agentKeys.join("/")}; the expression runs in the engine, no leaf is spawned`);
      }
      if (t.forEach !== undefined) {
        errors.push(`${l}: a task cannot be both forEach and compute — compute the list in one step, forEach over it in the next`);
      }
    } else {
      if (!t.prompt || typeof t.prompt !== "string") errors.push(`${l}: prompt is required`);
      if (!t.model || typeof t.model !== "string") errors.push(`${l}: model is required`);
    }
    if (t.isolation !== undefined && t.isolation !== "worktree") {
      errors.push(`${l}: isolation must be "worktree" when present (got ${JSON.stringify(t.isolation)})`);
    }
    if (t.timeoutMs !== undefined && (!Number.isInteger(t.timeoutMs) || t.timeoutMs < 1)) {
      errors.push(`${l}: timeoutMs must be a positive integer`);
    }
  }
}

// `itemAllowed`: child tasks under a forEach parent node may read {{item}}
// even without their own forEach — the parent substitutes at clone time.
function validateTaskRelations(rawTasks, errors, label, { itemAllowed = false } = {}) {
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
    if (t.compute === undefined && t.manifest === undefined && t.effort !== undefined && !isValidEffort(t.model, t.effort)) {
      const tier = tierFromModel(t.model);
      errors.push(`${l}: effort '${t.effort}' is not valid for ${tier} (allowed: ${TIER_EFFORTS[tier].join(", ")})`);
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

    if (t.verifyCitations !== undefined && typeof t.verifyCitations !== "boolean") {
      errors.push(`${l}: verifyCitations must be true or false (got ${JSON.stringify(t.verifyCitations)}) — citation-shaped returns are verified by default; false opts out`);
    }
  }
}

// ── shared normalization ──────────────────────────────────────────────────────
// Governance gate — deny-by-default for non-Claude models. The employer's
// data agreement covers Anthropic only; open-model tasks may run only under
// directories the user has explicitly allow-listed. Checked against the
// task's ORIGINAL effective cwd (before any scratch redirect).

// Denylist — takes a model out of circulation machine-wide. Case-insensitive
// substring so the config author controls precision ("nemotron" bans the
// family; a full name bans exactly one). Returns the matching entry for the
// error message, undefined when clear. Shared with the CLI's roster filter.
export function matchDenylist(model, cfg) {
  const lower = String(model || "").toLowerCase();
  return (cfg?.modelDenylist || []).find(
    (e) => typeof e === "string" && e && lower.includes(e.toLowerCase())
  );
}

function checkDenylist(model, l, cfg, errors) {
  const hit = matchDenylist(model, cfg);
  if (hit) {
    errors.push(
      `${l}: model '${model}' is denylisted in config (matched '${hit}') — remove it from ` +
      `modelDenylist in ~/.swarm/config.json or pick another model; see 'swarm models'`
    );
  }
}

function checkGovernance(model, effCwd, l, cfg, errors) {
  if (isClaudeModel(model)) return;
  const allowedRoots = cfg?.provider?.allowedRoots || [];
  if (!allowedRoots.some((root) => isUnderRoot(effCwd, root))) {
    errors.push(
      `${l}: model '${model}' is not a Claude model and its cwd '${effCwd}' is not under any ` +
      `provider.allowedRoots entry — blocked by data governance policy (only Anthropic is covered ` +
      `by the data agreement). Configure provider.allowedRoots in ~/.swarm/config.json to permit open-model dispatch there.`
    );
  }
}

function normalizeTasks(rawTasks, { cwd, resultsDir, cfg, defaultTimeoutMs, errors, label, childPlans }) {
  const governanceCheck = (model, effCwd, l) => checkGovernance(model, effCwd, l, cfg, errors);

  return rawTasks.map((t) => {
    const l = label(t);
    const isCompute = t.compute !== undefined;
    const isManifest = t.manifest !== undefined;
    const originalCwd = t.cwd ? resolve(cwd, t.cwd) : cwd;
    // compute/manifest nodes spawn nothing themselves and no code leaves the
    // machine — no governance, no write-implies-isolation.
    if (!isCompute && !isManifest) {
      governanceCheck(t.model, originalCwd, l);
      checkDenylist(t.model, l, cfg, errors);
      if (t.fallbackModel !== undefined) {
        if (typeof t.fallbackModel !== "string" || !t.fallbackModel) {
          errors.push(`${l}: fallbackModel must be a model name string`);
        } else {
          // the fallback is a real dispatch target — same governance as the primary
          governanceCheck(t.fallbackModel, originalCwd, `${l} fallback`);
          checkDenylist(t.fallbackModel, `${l} fallback`, cfg, errors);
        }
      }
    }
    let effCwd = originalCwd;
    let scratchRedirect = false;
    // Write-implies-isolation: a leaf granted write-capable tools without
    // worktree isolation never runs in the user's real tree — its cwd is
    // redirected to a per-task scratch dir under the results dir.
    if (!isCompute && !isManifest && hasWriteTools(t.allowedTools) && t.isolation !== "worktree") {
      effCwd = join(resultsDir, `scratch-${t.id}`);
      scratchRedirect = true;
    }
    const whenBlock = t.when && typeof t.when === "object" && !Array.isArray(t.when)
      ? { when: { from: t.when.from, expr: t.when.expr } } : {};
    const forEachBlock = !isCompute && t.forEach && typeof t.forEach === "object" && !Array.isArray(t.forEach)
      ? { forEach: { from: t.forEach.from, path: t.forEach.path ?? "", maxItems: t.forEach.maxItems } } : {};
    return {
      id: t.id,
      prompt: isCompute || isManifest ? "" : t.prompt,
      // "compute"/"manifest" are display sentinels, never dispatched — these
      // nodes run inline in the engine (the scheduler excludes them from
      // preflights; a manifest node expands into its child's tasks).
      model: isManifest ? "manifest" : isCompute ? "compute" : t.model,
      fallbackModel: !isCompute && !isManifest && typeof t.fallbackModel === "string" ? t.fallbackModel : undefined,
      effort: isCompute || isManifest ? undefined : t.effort,
      allowedTools: isCompute || isManifest ? "" : t.allowedTools || DEFAULT_TOOLS,
      cwd: effCwd,
      originalCwd,
      scratchRedirect,
      isolation: isCompute || isManifest ? undefined : t.isolation,
      outputDir: t.outputDir ? resolve(cwd, t.outputDir) : undefined,
      timeoutMs: t.timeoutMs ?? defaultTimeoutMs,
      after: [...(t.after || [])],
      ...(isCompute && { compute: t.compute }),
      ...whenBlock,
      ...forEachBlock,
      ...(!isCompute && !isManifest && t.returns && typeof t.returns === "object" && !Array.isArray(t.returns) && { returns: t.returns }),
      ...(typeof t.verifyCitations === "boolean" && { verifyCitations: t.verifyCitations }),
      ...(childPlans?.has(t.id) && { childPlan: childPlans.get(t.id) }),
    };
  });
}

// ── child manifests (bounded one-level composition) ───────────────────────────
// A "manifest" task runs a child manifest as one node: statically loaded and
// validated here (errors surface in the parent's validate, prefixed), spliced
// into the run by the scheduler. The child inherits the parent run's cwd and
// resultsDir; it may not steer the run itself.

function loadChild(node, parentPath, cwd, cfg, resultsDir, errors, { args, usedArgs, fromRegistry } = {}) {
  const nodeLabel = `task '${node.id}'`;
  // A registry-resolved parent references its children relative to itself — a
  // saved manifest must work from any cwd. Plain-path parents keep cwd
  // resolution (today's behaviour, unchanged).
  const childPath = resolve(fromRegistry ? dirname(parentPath) : cwd, node.manifest);
  let raw;
  try {
    raw = readManifestJson(childPath);
  } catch (e) {
    errors.push(`${nodeLabel}: cannot read child manifest ${childPath}: ${e.message}`);
    return undefined;
  }
  if (!Array.isArray(raw.tasks) || raw.tasks.length === 0) {
    errors.push(`${nodeLabel}: child manifest '${node.manifest}' must contain a non-empty 'tasks' array`);
    return undefined;
  }
  for (const key of ["resultsDir", "concurrency", "digest"]) {
    if (raw[key] !== undefined) {
      errors.push(`${nodeLabel}: child manifest '${node.manifest}' may not set ${key} — the parent owns the run`);
    }
  }
  for (const t of raw.tasks) {
    if (t && typeof t === "object" && t.manifest !== undefined) {
      errors.push(
        `${nodeLabel}: one nesting level — '${basename(parentPath)}' -> '${node.manifest}' may not contain ` +
        `another manifest task ('${t.id}')`
      );
    }
  }
  const label = (t) => `${nodeLabel} -> child '${t?.id ?? "with missing id"}'`;
  applyArgsToRawTasks(raw.tasks, args, usedArgs, errors, label);
  validateTaskShapes(raw.tasks, errors, label);
  // {{item}} in a child task without its own forEach is legal only when the
  // parent node fans out — the parent substitutes into child prompts per item.
  validateTaskRelations(raw.tasks, errors, label, { itemAllowed: node.forEach !== undefined });
  const cycle = detectCycle(raw.tasks.filter((t) => t.id));
  if (cycle) errors.push(`${nodeLabel}: dependency cycle in child manifest: ${cycle.join(" -> ")}`);
  const tasks = normalizeTasks(raw.tasks, {
    cwd, resultsDir, cfg, errors, label,
    defaultTimeoutMs: node.timeoutMs ?? raw.timeoutMs ?? cfg.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  });
  return { tasks };
}

// Load + validate a manifest into a normalized plan. Throws ValidationError
// listing every problem found. `cwd` is the invoking process's cwd — the
// default task cwd and the base for relative paths. Options: `args` (the
// --args object, substituted as {{args.<key>}} before validation),
// `fromRegistry` (child manifest paths then resolve against the parent's dir),
// and `ref` (the pre-resolution registry name, recorded on the plan for the
// run dir snapshot).
export function loadManifest(path, cfg, cwd = process.cwd(), { args, fromRegistry = false, ref } = {}) {
  const errors = [];
  if (args !== undefined && (args === null || typeof args !== "object" || Array.isArray(args))) {
    throw new ValidationError([`args must be a JSON object — e.g. {"base":"master"} (got ${JSON.stringify(args)})`]);
  }
  const manifestPath = resolve(cwd, path);
  let raw;
  try {
    raw = readManifestJson(manifestPath);
  } catch (e) {
    throw new ValidationError([`cannot read manifest ${manifestPath}: ${e.message}`]);
  }

  if (!Array.isArray(raw.tasks) || raw.tasks.length === 0) {
    throw new ValidationError(["manifest must contain a non-empty 'tasks' array"]);
  }

  const usedArgs = new Set();
  const argsLabel = (t) => (t?.id ? `task '${t.id}'` : "task with missing id");
  applyArgsToRawTasks(raw.tasks, args, usedArgs, errors, argsLabel);
  // instructions AND the report steer are both prompt text — an un-substituted
  // {{args.x}} in either reaches the leaf verbatim.
  if (raw.digest && typeof raw.digest === "object") {
    for (const key of ["instructions", "report"]) {
      if (typeof raw.digest[key] !== "string") continue;
      const carrier = { prompt: raw.digest[key] };
      applyArgsToRawTasks([carrier], args, usedArgs, errors, () => "digest");
      raw.digest[key] = carrier.prompt;
    }
  }
  // `goal` flows into the digest prompt AND is what the report titles itself from,
  // so an un-substituted {{args.x}} there disfigures every report's title. It was
  // the one prompt-bound field the substitution pass skipped.
  if (typeof raw.goal === "string" && raw.goal.includes("{{")) {
    const carrier = { prompt: raw.goal };
    applyArgsToRawTasks([carrier], args, usedArgs, errors, () => "goal");
    raw.goal = carrier.prompt;
  }

  const resultsDir = raw.resultsDir
    ? resolve(cwd, raw.resultsDir)
    : defaultResultsDir(manifestPath, cwd, argsFingerprint(args));

  const concurrency = raw.concurrency ?? cfg.concurrency ?? 4;
  if (!Number.isInteger(concurrency) || concurrency < 1) {
    errors.push(`concurrency must be a positive integer (got ${JSON.stringify(raw.concurrency)})`);
  }

  const label = (t) => (t?.id ? `task '${t.id}'` : "task with missing id");
  validateTaskShapes(raw.tasks, errors, label);
  validateTaskRelations(raw.tasks, errors, label);

  const cycle = detectCycle(raw.tasks.filter((t) => t.id));
  if (cycle) errors.push(`dependency cycle detected: ${cycle.join(" -> ")}`);

  const childPlans = new Map();
  for (const t of raw.tasks) {
    if (t && typeof t === "object" && typeof t.manifest === "string" && t.manifest) {
      const child = loadChild(t, manifestPath, cwd, cfg, resultsDir, errors, { args, usedArgs, fromRegistry });
      if (child) childPlans.set(t.id, child);
    }
  }

  // Symmetric typo protection: a supplied key nothing reads is as suspect as a
  // placeholder nothing supplies.
  for (const k of Object.keys(args || {})) {
    if (!usedArgs.has(k)) {
      errors.push(`--args key '${k}' is never referenced by the manifest — remove it or add {{args.${k}}} where intended`);
    }
  }

  const tasks = normalizeTasks(raw.tasks, {
    cwd, resultsDir, cfg, errors, label, childPlans,
    defaultTimeoutMs: raw.timeoutMs ?? cfg.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  });

  let digest;
  if (raw.digest !== undefined) {
    if (!raw.digest || typeof raw.digest !== "object" || !raw.digest.model) {
      errors.push("digest block must be an object with a 'model'");
    } else {
      checkGovernance(raw.digest.model, cwd, "digest", cfg, errors);
      checkDenylist(raw.digest.model, "digest", cfg, errors);
      const report = raw.digest.report;
      if (report !== undefined && report !== true && report !== false && typeof report !== "string") {
        errors.push("digest.report must be true, false, or a steering string for the report body");
      }
      digest = {
        model: raw.digest.model,
        instructions: raw.digest.instructions || "",
        ...(report && { report }),
      };
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
    ...(args && Object.keys(args).length && { args }),
    ...(ref && { ref }),
  };
}

// The effective plan as approved and dispatched: args substituted, children
// resolved, engine defaults stripped back to authored intent. Single source
// for the `validate --resolved` preview and the run dir's manifest.json (P1) —
// what you approve is byte-for-byte what the run records.
export function effectivePlanDoc(plan) {
  const strip = (t) => {
    const o = { id: t.id, model: t.model };
    if (t.prompt) o.prompt = t.prompt;
    for (const k of ["effort", "allowedTools", "after", "when", "forEach", "compute", "returns", "verifyCitations", "isolation", "outputDir"]) {
      if (t[k] !== undefined && t[k] !== "" && !(Array.isArray(t[k]) && t[k].length === 0)) o[k] = t[k];
    }
    if (t.childPlan) o.child = t.childPlan.tasks.map(strip);
    return o;
  };
  return {
    ...(plan.goal && { goal: plan.goal }),
    ...(plan.ref && { ref: plan.ref }),
    ...(plan.args && { args: plan.args, argsFingerprint: argsFingerprint(plan.args) }),
    resultsDir: plan.resultsDir,
    tasks: plan.tasks.map(strip),
    ...(plan.digest && { digest: plan.digest }),
  };
}
