// What an authored task node may look like: its key vocabulary, its id rules, and
// the per-node shape rules that apply before any relation between tasks is read.

import { CONTEXT_WINDOWS } from "./contracts.mjs";
import { hasWriteTools, isAgentless } from "./manifest-task-policy.mjs";

const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const CLONE_ID_RE = /\[\d+\]$/;

// Keys that existed and no longer do. Each gets its own message naming what replaced it,
// so the generic unknown-key error never fires for one and say nothing useful.
const RETIRED_TASK_KEYS = new Set(["isolation"]);
const KNOWN_TASK_KEYS = new Set([
  "id", "prompt", "model", "provider", "fallbackModel", "fallbackProvider", "effort", "allowedTools", "cwd",
  "workspace", "branch", "outputDir", "timeoutMs", "after", "compute", "when", "forEach",
  "returns", "verifyCitations", "manifest", "integrate", "settings", "leafGuard",
  "mustRead", "contextWindow",
]);

// A manifest task is an agentless container for its child's tasks — every
// leaf-shaped key on the node itself is an authoring mistake.
const MANIFEST_BANNED_KEYS = [
  "prompt", "model", "compute", "returns", "workspace", "branch", "allowedTools",
  "outputDir", "effort", "fallbackModel", "mustRead", "contextWindow",
];

// The scheduler spreads these last so a task's own `env` can't override them;
// `--settings`' env block is a second, higher-precedence path to the same
// leaf process and must be closed the same way.
const LEAF_GUARD_ENV_KEYS = ["SWARM_LEAF", "SWARM_LEAF_GUARD", "SWARM_LEAF_GUARD_PROJECT"];

// ── shared per-task validation ────────────────────────────────────────────────
// One rule set for parent and child task lists. `label(t)` renders the error
// prefix — child errors read "task 'audit' -> child 'scan': …".

export function validateTaskShapes(rawTasks, errors, label) {
  const seen = new Set();
  for (const t of rawTasks) {
    const l = label(t);
    for (const k of Object.keys(t || {})) {
      if (RETIRED_TASK_KEYS.has(k)) continue;   // named individually below, with its replacement
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
      const agentKeys = ["model", "prompt", "fallbackModel", "effort", "allowedTools", "workspace", "branch", "outputDir", "contextWindow"]
        .filter((k) => t[k] !== undefined);
      if (agentKeys.length) {
        errors.push(`${l}: compute tasks are agentless — remove ${agentKeys.join("/")}; the expression runs in the engine, no leaf is spawned`);
      }
      if (t.forEach !== undefined) {
        errors.push(`${l}: a task cannot be both forEach and compute — compute the list in one step, forEach over it in the next`);
      }
    } else if (t.integrate !== undefined) {
      // Agentless like compute: the engine merges, no leaf is spawned.
      // `workspace`/`branch` too: an integrate node's tree is `integrate.into`, so naming
      // one here would validate and be silently ignored.
      const agentKeys = ["model", "prompt", "fallbackModel", "effort", "allowedTools", "returns", "workspace", "branch", "outputDir", "contextWindow"]
        .filter((k) => t[k] !== undefined);
      if (agentKeys.length) {
        errors.push(`${l}: integrate tasks are agentless — remove ${agentKeys.join("/")}; the merge runs in the engine, no leaf is spawned`);
      }
      const spec = t.integrate;
      if (!spec || typeof spec !== "object" || Array.isArray(spec)) {
        errors.push(`${l}: integrate must be an object — e.g. "integrate": {"into": "feat", "from": ["migrate-x", "migrate-y"]}`);
      } else {
        for (const k of Object.keys(spec)) {
          if (k !== "into" && k !== "from") {
            errors.push(`${l}: unknown key '${k}' in integrate — the shape is {"into": "<worktree name>", "from": ["<task id>", …]}`);
          }
        }
        if (typeof spec.into !== "string" || !spec.into) {
          errors.push(`${l}: integrate.into is required — the worktree name the merged work lands in; e.g. {"into": "feat", "from": ["migrate-x"]}`);
        }
        if (!Array.isArray(spec.from) || !spec.from.length) {
          errors.push(`${l}: integrate.from must be a non-empty array of task ids to merge — e.g. {"into": "feat", "from": ["migrate-x", "migrate-y"]}`);
        }
      }
    } else {
      if (!t.prompt || typeof t.prompt !== "string") errors.push(`${l}: prompt is required`);
      if (!t.model || typeof t.model !== "string") errors.push(`${l}: model is required`);
    }
    if (t.provider !== undefined && (typeof t.provider !== "string" || !/^[a-z][a-z0-9-]*$/.test(t.provider))) {
      errors.push(`${l}: provider must be a canonical lowercase identifier (e.g. \"codex\")`);
    }
    if (t.fallbackProvider !== undefined && (typeof t.fallbackProvider !== "string" || !/^[a-z][a-z0-9-]*$/.test(t.fallbackProvider))) {
      errors.push(`${l}: fallbackProvider must be a canonical lowercase identifier (e.g. \"claude\")`);
    }
    if (t.effort !== undefined && (typeof t.effort !== "string" || !t.effort.trim())) {
      errors.push(`${l}: effort must be a non-empty string — e.g. \"effort\": \"medium\"`);
    }
    // `isolation` is gone. Named explicitly rather than left to the unknown-key error,
    // because every manifest written before this change carries it and the generic
    // message would not say what to write instead.
    if (t.isolation !== undefined) {
      errors.push(
        `${l}: isolation was removed — a writer always gets a tree and a reader never does, so there is nothing to declare.\n` +
        `    Delete it. Only name a workspace if leaves must SHARE one tree:\n` +
        `        "workspace": "feat"\n` +
        `    To read a path in place, just point cwd at it — readers run in the live repo.`);
    }
    if (t.workspace !== undefined) {
      if (typeof t.workspace !== "string" || !t.workspace) {
        errors.push(`${l}: workspace must be a non-empty string naming the shared tree — e.g. "workspace": "feat"`);
      } else if (!/^[A-Za-z0-9._-]+$/.test(t.workspace)) {
        errors.push(
          `${l}: workspace '${t.workspace}' must be filename-safe ` +
          `(letters, digits, dot, dash, underscore) — it becomes a directory and a branch name`);
      } else if (!isAgentless(t) && t.manifest === undefined && !hasWriteTools(t.allowedTools)) {
        errors.push(
          `${l}: workspace is for leaves that WRITE — a read-only leaf owns no tree to share.\n` +
          `    Drop "workspace", or give it write tools — e.g. "allowedTools": "Read,Edit,Bash"`);
      }
    }
    if (t.branch !== undefined) {
      if (typeof t.branch !== "string" || !/^[A-Za-z0-9._\/-]+$/.test(t.branch)) {
        errors.push(
          `${l}: branch must be a git branch name (letters, digits, dot, dash, ` +
          `underscore, slash) — e.g. "branch": "swarm/eco-p3"`);
      } else if (!isAgentless(t) && t.manifest === undefined && !hasWriteTools(t.allowedTools)) {
        errors.push(
          `${l}: branch is for leaves that WRITE — a read-only leaf commits nothing, so it owns no branch.\n` +
          `    Drop "branch", or give it write tools — e.g. "allowedTools": "Read,Edit,Bash"`);
      }
    }
    if (t.timeoutMs !== undefined && (!Number.isInteger(t.timeoutMs) || t.timeoutMs < 1)) {
      errors.push(`${l}: timeoutMs must be a positive integer`);
    }
    if (t.contextWindow !== undefined && !CONTEXT_WINDOWS.has(t.contextWindow)) {
      errors.push(`${l}: contextWindow only accepts "1m" — e.g. "contextWindow": "1m"`);
    }
    // Goes red on a string/array/null: `--settings` takes a JSON object and anything else would reach the CLI as a file path that does not exist.
    if (t.settings !== undefined && (!t.settings || typeof t.settings !== "object" || Array.isArray(t.settings))) {
      errors.push(`${l}: settings must be a JSON object — e.g. "settings": {"env": {"CLAUDE_CODE_DISABLE_1M_CONTEXT": "0"}}`);
    } else if (t.settings?.env && typeof t.settings.env === "object" && !Array.isArray(t.settings.env)) {
      // `--settings` is highest-precedence in the CLI's own settings chain — a task
      // could otherwise clear or forge the guard vars inside its own leaf session,
      // defeating the engine's env spread (the same vector proven for
      // CLAUDE_CODE_DISABLE_1M_CONTEXT in dispatch.test.mjs).
      for (const key of LEAF_GUARD_ENV_KEYS) {
        if (Object.hasOwn(t.settings.env, key)) {
          errors.push(`${l}: settings.env may not set '${key}' — it is engine-controlled; use "leafGuard": false to opt out instead`);
        }
      }
    }
    // leafGuard is otherwise engine-computed (from ~/.swarm/config.json's
    // projects) — the only thing an author may write here is opting out.
    if (t.leafGuard !== undefined && t.leafGuard !== false) {
      errors.push(`${l}: leafGuard only accepts false — e.g. "leafGuard": false to opt this task out of the engine's leaf guard`);
    }
  }
}
