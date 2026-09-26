import { readFileSync, existsSync, readdirSync } from "node:fs";
import { resolve, join, basename, dirname } from "node:path";
import { createHash } from "node:crypto";
import { swarmHome, DEFAULT_TIMEOUT_MS } from "./config.mjs";
import { buildDispatch, createDispatchRegistry, runnerOf } from "./dispatch.mjs";
import { buildDigestTask } from "./digest.mjs";
import { usageFromCache } from "./ollama-usage.mjs";
import { checkGovernance, checkRunRoots } from "./governance.mjs";
import { manifestCwd, checkChildTopKeys } from "./manifest-top.mjs";
import { defaultManifestIo } from "./manifest-leaf-guard.mjs";
import { normalizeTasks } from "./manifest-normalize.mjs";
import { checkCommandLineLengths, measurablePrompt } from "./manifest-dispatch-budget.mjs";
import { validateTaskShapes } from "./manifest-task-shape.mjs";
import { detectCycle, validateTaskRelations, validateWorktreeGroups } from "./manifest-relations.mjs";
import { validateMustRead, validateMustReadRunners } from "./manifest-must-read.mjs";
import { PROVIDERS, checkDenylist, checkHeadroom, resolveProvider } from "./manifest-model-gates.mjs";

// The loader is the public surface: every name this module exported before it was
// split into the manifest-*.mjs modules is still exported from here, so no call
// site outside it had to move.
export { isUnderRoot } from "./roots.mjs";
export { checkRunRoots } from "./governance.mjs";
export { DEFAULT_TOOLS, hasWriteTools, resolveWorktreeName, isSharedTree, isAgentless, isSentinelModel } from "./manifest-task-policy.mjs";
export { realRepoToplevel, guardFor } from "./manifest-leaf-guard.mjs";
export { makeReaches } from "./manifest-relations.mjs";
export { MUST_READ_MAX_ENTRIES } from "./manifest-must-read.mjs";
export { matchDenylist } from "./manifest-model-gates.mjs";
export { FOREACH_ITEM_MAX } from "./manifest-dispatch-budget.mjs";

export class ValidationError extends Error {
  constructor(errors) {
    super(`manifest validation failed:\n  - ${errors.join("\n  - ")}`);
    this.name = "ValidationError";
    this.errors = errors;
  }
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

// Default resultsDir: ~/.swarm/runs/<encoded-repo-toplevel>/<manifest-stem>-<n> — run
// artefacts live in the user's home, never inside a code dir. Reuse the
// highest-numbered existing dir so a bare re-run resumes into the same run
// (resume skips ok results); first run gets -1. An explicit resultsDir in the
// manifest is always used verbatim (resolved against cwd). With --args the
// stem carries the args fingerprint — a differently-parameterized run must
// never resume into another parameterization's dir.
function defaultResultsDir(manifestPath, toplevel, argsFp) {
  const stem = basename(manifestPath).replace(/\.json$/i, "") + (argsFp ? `.${argsFp}` : "");
  const base = join(swarmHome(), "runs", toplevel.replace(/[\\/:]/g, "-"));
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

// Fence-tolerant JSON read — manifests may be model-authored, and models fence
// JSON in markdown; extend the same tolerance the engine gives leaf output.
// Exported for the registry's goal peek — one tolerance rule, not two.
export function readManifestJson(path) {
  const text = readFileSync(path, "utf8");
  const fenced = text.match(/^\s*```(?:json)?\s*([\s\S]*?)```\s*$/);
  return JSON.parse(fenced ? fenced[1] : text);
}

// ── child manifests (bounded one-level composition) ───────────────────────────
// A "manifest" task runs a child manifest as one node: statically loaded and
// validated here (errors surface in the parent's validate, prefixed), spliced
// into the run by the scheduler. The child inherits the parent run's cwd and
// resultsDir; it may not steer the run itself.

function loadChild(node, parentPath, cwd, cfg, resultsDir, errors, { args, usedArgs, fromRegistry, cache = [], io, probedGuards, providerRegistry = PROVIDERS } = {}) {
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
  checkChildTopKeys(raw, `${nodeLabel}: child manifest '${node.manifest}' `, errors);
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
  validateMustRead(raw.tasks, errors, label);
  validateWorktreeGroups(raw.tasks, errors, label);
  const cycle = detectCycle(raw.tasks.filter((t) => t.id));
  if (cycle) errors.push(`${nodeLabel}: dependency cycle in child manifest: ${cycle.join(" -> ")}`);
  const tasks = normalizeTasks(raw.tasks, {
    cwd, resultsDir, cfg, errors, label, cache, io, probedGuards,
    providerRegistry,
    defaultTimeoutMs: node.timeoutMs ?? raw.timeoutMs ?? cfg.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  });
  checkCommandLineLengths(tasks, cfg, io, errors, label);
  validateMustReadRunners(tasks, cfg, io, errors, label, providerRegistry);
  return { tasks };
}

// Load + validate a manifest into a normalized plan. Throws ValidationError
// listing every problem found. `cwd` is the invoking process's cwd; a manifest's
// own `cwd` replaces it as the default task cwd and path base. Options: `args` (the
// --args object, substituted as {{args.<key>}} before validation),
// `fromRegistry` (child manifest paths then resolve against the parent's dir),
// `ref` (the pre-resolution registry name, recorded on the plan for the
// run dir snapshot), `cache` (the provider-qualified model roster used for
// identity resolution), and `headroom` (an ALREADY-COMPUTED ollama reading —
// `await getUsage(cfg)` — so callers that can fetch inject it and tests can
// inject a fake; the default is the cache-only usageFromCache, which never
// touches the network, so validation stays offline unless the caller fetches).
export function loadManifest(path, cfg, cwd = process.cwd(), { args, fromRegistry = false, ref, cache = [], io, headroom = usageFromCache(cfg), providerRegistry = PROVIDERS, runnerRegistry } = {}) {
  const errors = [];
  const warnings = [];
  const resolvedIo = { ...defaultManifestIo(), ...io };
  const probedGuards = new Set();
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
  cwd = manifestCwd(raw, cwd, errors);

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
  // so an un-substituted {{args.x}} there disfigures every report's title.
  if (typeof raw.goal === "string" && raw.goal.includes("{{")) {
    const carrier = { prompt: raw.goal };
    applyArgsToRawTasks([carrier], args, usedArgs, errors, () => "goal");
    raw.goal = carrier.prompt;
  }

  // Runs are filed under the dispatching repo, so a cwd outside any repo has no home.
  const toplevel = resolvedIo.repoToplevel(cwd);
  if (!toplevel) {
    throw new ValidationError([
      `swarm: '${cwd}' is not inside a git repository, so this run has no project to be filed under. Run from the repo the work belongs to and pass the manifest by absolute path: cd <repo>; swarm run "<abs manifest path>"`,
    ]);
  }
  const resultsDir = raw.resultsDir
    ? resolve(cwd, raw.resultsDir)
    : defaultResultsDir(manifestPath, toplevel, argsFingerprint(args));

  // config.concurrency is a ceiling: the machine paying for the sessions sets
  // it, and a manifest may run narrower but never wider.
  const ceiling = cfg.concurrency ?? 4;
  const concurrency = raw.concurrency ?? ceiling;
  if (!Number.isInteger(concurrency) || concurrency < 1) {
    errors.push(`concurrency must be a positive integer (got ${JSON.stringify(raw.concurrency)})`);
  } else if (concurrency > ceiling) {
    errors.push(`concurrency ${concurrency} exceeds the ceiling ${ceiling} set by ~/.swarm/config.json — lower the manifest's concurrency, or raise the ceiling there`);
  }

  const label = (t) => (t?.id ? `task '${t.id}'` : "task with missing id");
  validateTaskShapes(raw.tasks, errors, label);
  validateTaskRelations(raw.tasks, errors, label);
  validateMustRead(raw.tasks, errors, label);
  validateWorktreeGroups(raw.tasks, errors, label);

  const cycle = detectCycle(raw.tasks.filter((t) => t.id));
  if (cycle) errors.push(`dependency cycle detected: ${cycle.join(" -> ")}`);

  // The run's repo must sit under the roots of some provider this manifest seats — the
  // union, since the per-task gate refuses each out-of-bounds task individually. Runs BEFORE
  // normalizeTasks, which probes a project's configured preToolUse hook with cwd in this
  // repo: a gate after that has already executed an operator command in the repo it refuses.
  // Seats come from the raw tasks for the same reason; a child manifest's own providers are
  // therefore not in the union, which can only refuse a run the parent's seats would allow.
  const seated = [...new Set(raw.tasks.flatMap((t) => [t?.provider, t?.fallbackProvider]).filter(Boolean))].sort();
  // An agentless-only manifest seats nobody, yet an integrate node still merges into this
  // repo — so it is judged against every configured provider's roots rather than none.
  const gateIds = seated.length ? seated : Object.keys(cfg.providers || {}).sort();
  checkRunRoots(gateIds, cfg, toplevel, errors);

  const childPlans = new Map();
  for (const t of raw.tasks) {
    if (t && typeof t === "object" && typeof t.manifest === "string" && t.manifest) {
      const child = loadChild(t, manifestPath, cwd, cfg, resultsDir, errors, { args, usedArgs, fromRegistry, cache, io: resolvedIo, probedGuards, providerRegistry });
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
    cwd, resultsDir, cfg, errors, label, childPlans, cache, headroom, warnings, io: resolvedIo, probedGuards, providerRegistry,
    defaultTimeoutMs: raw.timeoutMs ?? cfg.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  });
  checkCommandLineLengths(tasks, cfg, resolvedIo, errors, label);
  validateMustReadRunners(tasks, cfg, resolvedIo, errors, label, providerRegistry);

  let digest;
  // Set when the digest's own governance check already refused its cwd — the
  // dispatch-contract check below reconstructs the same dispatch from the same
  // config, so it would report that denial a second time.
  let digestGovernanceDenied = false;
  if (raw.digest !== undefined) {
    if (!raw.digest || typeof raw.digest !== "object" || !raw.digest.model) {
      errors.push("digest block must be an object with a 'model'");
    } else {
      const digestIdentity = resolveProvider({
        model: raw.digest.model,
        ...(raw.digest.provider !== undefined && { provider: raw.digest.provider }),
      }, cfg, cache, "digest", errors, providerRegistry);
      if (digestIdentity) {
        const before = errors.length;
        checkGovernance(digestIdentity.provider, raw.digest.model, cwd, "digest", cfg, errors);
        digestGovernanceDenied = errors.length > before;
        checkHeadroom(digestIdentity.provider, raw.digest.model, "digest", headroom, errors, warnings);
      }
      checkDenylist(raw.digest.model, "digest", cfg, errors);
      const report = raw.digest.report;
      if (report !== undefined && report !== true && report !== false && typeof report !== "string") {
        errors.push("digest.report must be true, false, or a steering string for the report body");
      }
      digest = {
        model: raw.digest.model,
        provider: digestIdentity?.provider,
        instructions: raw.digest.instructions || "",
        ...(report && { report }),
      };
    }
  }

  // The digest leaf is dispatched through the same buildDispatch/toSpawnable
  // path as any other task (scheduler.mjs), so its prompt is just as exposed
  // to the win32 command-line cap — build it the same way the scheduler does
  // and measure it too.
  if (digest) {
    const digestTask = buildDigestTask({ tasks, resultsDir, goal: raw.goal || "", digest, cwd });
    checkCommandLineLengths([digestTask], cfg, resolvedIo, errors, () => "digest");
    // ...and the same dispatch is built once more, because the engine's own task
    // has no second reporter: the measurement above swallows a dispatch exception
    // (every ordinary task reports its own problems through normalization), which
    // is exactly how a provider that cannot accept the digest surfaced only as a
    // zero-duration runtime failure. Built on EVERY platform with the registries
    // execution will use; the dispatch contract is platform-independent and only
    // the length measurement is win32-specific. Pure — nothing is spawned.
    if (digest.provider && !digestGovernanceDenied) {
      const effectiveRunnerRegistry = runnerRegistry || createDispatchRegistry({ providerRegistry }).runnerRegistry;
      try {
        buildDispatch(digestTask, measurablePrompt(digestTask.prompt, cfg), cfg, {
          providerRegistry, runnerRegistry: effectiveRunnerRegistry, cache,
        });
      } catch (e) {
        errors.push(`digest: the generated digest for provider '${digest.provider}' cannot be dispatched: ${e.message}`);
      }
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
    // The dispatching repo, which the run is filed under.
    repoToplevel: toplevel,
    ...(args && Object.keys(args).length && { args }),
    ...(ref && { ref }),
    ...(warnings.length && { warnings }),
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
    // `workspace` and `branch` are recorded as authored — a derived tree is not authored,
    // and there is no longer any normalised form to project back.
    if (t.branchName !== undefined) o.branch = t.branchName;
    for (const k of ["provider", "fallbackModel", "fallbackProvider", "effort", "allowedTools", "after", "when", "forEach", "compute", "returns", "verifyCitations", "workspace", "outputDir", "mustRead", "contextWindow"]) {
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
    cwd: plan.cwd,
    tasks: plan.tasks.map(strip),
    ...(plan.digest && { digest: plan.digest }),
  };
}
