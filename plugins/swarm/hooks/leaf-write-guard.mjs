#!/usr/bin/env node
// PreToolUse hook (matcher Write|Edit|NotebookEdit on Claude, apply_patch on Codex):
// deny a write whose resolved path falls outside the allowed roots — passed in argv,
// or in SWARM_WRITE_GUARD_ROOTS when argv carries none.
//
// Why this exists: `--allowedTools` gates tool NAMES, never paths — `Write(dir/**)`
// is not a valid specifier there, `--add-dir` extends reads only, and
// `permissions.deny` binds Edit/Read but not Write. A PreToolUse hook is the only
// primitive that confines a WRITE, so this is the one mechanism swarm can inject.
//
// It is INJECTED, never installed: src/manifest-normalize.mjs (and src/dispatch.mjs, for the report digest) merges it into each write-capable
// leaf's own `--settings` on the command line. A settings file inside the worktree
// would sit where the leaf can rewrite it, which defeats the purpose. That also
// distinguishes this from the CONFIGURED leaf guard (`projects[].hooks.preToolUse`,
// hooks/leaf-guard.mjs), which reaches a leaf as SWARM_LEAF_GUARD env vars and only
// works on a machine that has its own hook reading them.
//
// FAIL OPEN on anything unparseable, and on an invocation carrying no roots. The
// escape this guards against is real but rare; a guard that fails closed would brick
// every write-capable leaf on the first malformed payload, and a guard with nothing
// to enforce against would deny every write it ever sees.
//
// DENY, never ask: a leaf runs headless, so an `ask` decision has nobody to answer
// it and would hang the leaf until its timeout.

import { realpathSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { isUnderRoot } from "../src/roots.mjs";

// This module's own path, from its URL rather than process.cwd(): the engine
// dispatches leaves from arbitrary directories, and a cwd-relative path would
// point at nothing there. The emitters import it so exactly one place knows it.
export const HOOK_PATH = fileURLToPath(import.meta.url);
export const WRITE_GUARD_MATCHER = "Write|Edit|NotebookEdit";

function deny(reason) {
  return {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: reason,
    },
  };
}

// Every symlink and junction along the path resolved away, so a link inside an
// allowed root that points outside it cannot be used to escape. A path that does
// not exist yet — the ordinary case, a Write creating a file — is resolved from
// its nearest EXISTING ancestor, with the not-yet-created tail re-appended: the
// tail cannot be a link, so nothing is lost.
export function realResolve(p) {
  let current = resolve(p);
  const tail = [];
  for (;;) {
    try {
      const real = realpathSync(current);
      return tail.length ? join(real, ...[...tail].reverse()) : real;
    } catch {
      const parent = dirname(current);
      if (parent === current) return resolve(p); // no existing ancestor at all
      tail.push(basename(current));
      current = parent;
    }
  }
}

// Every file header a Codex patch touches. A Move to is a second write target, so
// it counts as much as the header it renames.
const PATCH_PATH = /^\*\*\* (?:(?:Add|Update|Delete) File|Move to): (.+)$/gm;

// The write's target paths — empty when the payload names none. NotebookEdit
// carries `notebook_path` where Write/Edit carry `file_path` — the matcher covers
// NotebookEdit, so reading only `file_path` would leave it unguarded. An
// apply_patch path is relative to the payload's cwd, not this hook's.
function attemptedPaths(payload) {
  const input = payload?.tool_input;
  if (payload?.tool_name === "apply_patch") {
    if (typeof input?.command !== "string" || typeof payload.cwd !== "string") return [];
    return [...input.command.matchAll(PATCH_PATH)].map((m) => resolve(payload.cwd, m[1].trim()));
  }
  const p = input?.file_path ?? input?.notebook_path;
  return typeof p === "string" && p ? [p] : [];
}

// Argv roots when the guard is injected via `--settings` (Claude); otherwise the
// SWARM_WRITE_GUARD_ROOTS JSON array the engine sets on a Codex leaf, whose one
// fixed hooks.json command cannot carry per-leaf argv. Anything but a non-empty
// array of strings is no roots.
function rootsFrom(argv, env) {
  if (argv.length) return argv;
  try {
    const roots = JSON.parse(env.SWARM_WRITE_GUARD_ROOTS);
    return Array.isArray(roots) && roots.length && roots.every((r) => typeof r === "string" && r) ? roots : [];
  } catch {
    return [];
  }
}

// The command string this guard is injected as. Quote every path: the runner
// executes this through a shell, and a Windows run home sits under a user profile
// whose name routinely holds a space.
export function guardCommand(roots) {
  return ["node", HOOK_PATH, ...roots].map((part, i) => (i === 0 ? part : `"${part}"`)).join(" ");
}

// Merge the guard into a task's effective settings so the ENGINE's entry survives
// whatever the task authored. A task may add its own PreToolUse hooks; prepending
// ours, rather than letting deepMerge replace the array, is what stops a task from
// dropping the guard that contains it. Returns `settings` untouched when there is
// nothing to enforce — a guard with no roots would deny every write.
export function applyWriteGuard(settings, roots) {
  if (!Array.isArray(roots) || !roots.length) return settings;
  const entry = { matcher: WRITE_GUARD_MATCHER, hooks: [{ type: "command", command: guardCommand(roots) }] };
  const prior = settings?.hooks?.PreToolUse;
  const existing = prior === undefined ? [] : Array.isArray(prior) ? prior : [prior];
  return { ...(settings || {}), hooks: { ...(settings?.hooks || {}), PreToolUse: [entry, ...existing] } };
}

async function main() {
  try {
    const roots = rootsFrom(process.argv.slice(2), process.env);
    let stdin = "";
    process.stdin.setEncoding("utf8");
    for await (const chunk of process.stdin) stdin += chunk;

    if (!roots.length) {
      process.exit(0); // nothing to enforce against — fail open
      return;
    }

    let payload = null;
    try { payload = JSON.parse(stdin); } catch { /* fail open below */ }

    const attempted = attemptedPaths(payload);
    if (!attempted.length) {
      process.exit(0); // unparseable, or a tool call with no path — fail open
      return;
    }

    // Roots are resolved too: the run home, the user's temp dir and a checkout can
    // each sit behind a link of their own, and comparing a resolved path against an
    // unresolved root would deny writes inside the very tree being guarded.
    const realRoots = roots.map((r) => {
      try { return realResolve(r); } catch { return resolve(r); }
    });

    const outside = attempted.find((p) => !realRoots.some((root) => isUnderRoot(realResolve(p), root)));
    if (outside) {
      // Both halves in the reason: it is the only diagnostic the digest carries.
      process.stdout.write(JSON.stringify(deny(`${outside} is outside ${realRoots.join(", ")}`)));
    }
  } catch {
    // Fail OPEN even on this hook's own bug: a crashed guard must not be the reason
    // a leaf cannot work. (Contrast hooks/leaf-guard.mjs, whose failure mode is the
    // 50 GB build it exists to prevent, and which therefore fails closed.)
  }
  process.exit(0);
}

// Entry-point guard: importing this for its helpers must not start reading stdin.
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main();
}
