// The configured leaf write guard: finding the project whose preToolUse hook
// governs a task's cwd, probing it once at validate time, and the injectable io
// seam the loader and normalizer share.

import { spawnSync as nodeSpawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { basename } from "node:path";
import { checkoutToplevel, treeRootFor } from "./worktree.mjs";
import { swarmHome } from "./config.mjs";
import { mcpTools } from "./manifest-task-policy.mjs";

function namesEqual(a, b) {
  return process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
}

// The MAIN worktree of the repo containing cwd, an explicit non-repo answer, or a
// failed lookup. A spawn failure must stay distinct from git's "not a repository" answer.
export function repoLookup(cwd, spawn) {
  if (!existsSync(cwd)) return { none: "missing-cwd" };
  const run = spawn || nodeSpawnSync;
  const result = run("git", ["worktree", "list", "--porcelain"], { cwd, encoding: "utf8" });
  const stderr = (result.stderr || "").toString().trim();
  if (result.error) return { failed: result.error.message || String(result.error) };
  if (result.signal) return { failed: "git was terminated by " + result.signal };
  if (result.status === null || result.status === undefined) return { failed: "git returned no exit status" };
  if (result.status !== 0) {
    if (result.status === 128 && /not a git repository/i.test(stderr)) return { none: "not-a-repo" };
    return { failed: "git exited with status " + result.status + (stderr ? ": " + stderr : "") };
  }
  if (!result.stdout) return { failed: "git returned empty worktree output" };
  // Blocks are blank-line separated; only the first one describes the main worktree.
  const block = result.stdout.trim().split(/\r?\n/);
  const end = block.indexOf("");
  const main = end === -1 ? block : block.slice(0, end);
  if (main.includes("bare")) return { none: "bare" };
  const match = /^worktree (.+)$/.exec(main[0] || "");
  return match ? { repo: match[1].trim() } : { failed: "git returned no main worktree path" };
}

// Existing callers need only the repo path and retain their null-on-no-repo contract.
export function realRepoToplevel(cwd, spawn) {
  return repoLookup(cwd, spawn).repo || null;
}
// The leaf guard governing a task's cwd, or undefined if none applies. The
// task matches the project whose name equals the basename of its repo root
// (via the injectable io.repoToplevel seam so tests need no real git),
// falling back to the basename of originalCwd itself when git fails —
// case-insensitive on Windows, same as isUnderRoot.
export function guardFor(originalCwd, cfg, io = defaultManifestIo()) {
  const projects = cfg?.projects;
  if (!Array.isArray(projects) || !projects.length) return undefined;
  const toplevel = io.repoToplevel(originalCwd);
  const name = basename(toplevel || originalCwd);
  const project = projects.find((p) => namesEqual(p.name, name));
  if (!project) return undefined;
  const command = project.hooks?.preToolUse;
  if (!command) return undefined;
  return { name: project.name, command };
}

export function defaultManifestIo(cfg) {
  return {
    spawnSync: (command, opts) => nodeSpawnSync(command, { shell: true, encoding: "utf8", ...opts }),
    stdout: (line) => console.log(line),
    repoToplevel: realRepoToplevel,
    repoLookup,
    checkoutToplevel,
    // The machine's own MCP servers, for the leaf toolset normalize fills in.
    mcpTools,
    // Governance judges a tree under the swarm home by its repo; tests point this at a temp dir.
    home: swarmHome(),
    treeRoot: treeRootFor(cfg),
    platform: process.platform,
  };
}

// A guard is probed once per distinct name+command, from the first task that
// resolves it — a broken guard must fail validation before any leaf spawns.
export function probeGuard(guard, originalCwd, l, io, probedGuards, errors) {
  const key = `${guard.name}|${guard.command}`;
  if (probedGuards.has(key)) return;
  probedGuards.add(key);
  const result = io.spawnSync(guard.command, {
    cwd: originalCwd,
    input: JSON.stringify({ tool_name: "Bash", tool_input: { command: "true" } }),
  });
  const status = result.status ?? 0;
  if (status !== 0) {
    errors.push(
      `${l}: leaf guard for project '${guard.name}' ('${guard.command}') failed validation ` +
      `(exit ${status}): ${(result.stderr || "").toString().trim()}`
    );
  }
}
