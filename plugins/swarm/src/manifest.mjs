import { readFileSync, existsSync, readdirSync } from "node:fs";
import { resolve, join, basename, sep } from "node:path";
import { swarmHome } from "./config.mjs";
import { isClaudeModel, isValidEffort, tierFromModel, TIER_EFFORTS } from "./models.mjs";

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
    if (typeof t.id === "string" && t.id.startsWith("__")) {
      errors.push(`${label}: ids starting with '__' are reserved for engine-synthesized tasks`);
    } else if (!t.id || typeof t.id !== "string" || !ID_RE.test(t.id)) {
      errors.push(`${label}: id is required and must be filename-safe ([A-Za-z0-9._-], not starting with '.'/'-')`);
    } else if (seen.has(t.id)) {
      errors.push(`${label}: duplicate id`);
    }
    seen.add(t.id);
    if (!t.prompt || typeof t.prompt !== "string") errors.push(`${label}: prompt is required`);
    if (!t.model || typeof t.model !== "string") errors.push(`${label}: model is required`);
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
    if (t.effort !== undefined && !isValidEffort(t.model, t.effort)) {
      const tier = tierFromModel(t.model);
      errors.push(`task '${t.id}': effort '${t.effort}' is not valid for ${tier} (allowed: ${TIER_EFFORTS[tier].join(", ")})`);
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
    const originalCwd = t.cwd ? resolve(cwd, t.cwd) : cwd;
    governanceCheck(t.model, originalCwd, `task '${t.id}'`);
    let effCwd = originalCwd;
    let scratchRedirect = false;
    // Write-implies-isolation: a leaf granted write-capable tools without
    // worktree isolation never runs in the user's real tree — its cwd is
    // redirected to a per-task scratch dir under the results dir.
    if (hasWriteTools(t.allowedTools) && t.isolation !== "worktree") {
      effCwd = join(resultsDir, `scratch-${t.id}`);
      scratchRedirect = true;
    }
    return {
      id: t.id,
      prompt: t.prompt,
      model: t.model,
      effort: t.effort,
      allowedTools: t.allowedTools || DEFAULT_TOOLS,
      cwd: effCwd,
      originalCwd,
      scratchRedirect,
      isolation: t.isolation,
      outputDir: t.outputDir ? resolve(cwd, t.outputDir) : undefined,
      timeoutMs: t.timeoutMs ?? raw.timeoutMs ?? cfg.timeoutMs ?? 600000,
      after: [...(t.after || [])],
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
