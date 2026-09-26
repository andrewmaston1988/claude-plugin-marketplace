// The configured leaf write guard: finding the project whose preToolUse hook
// governs a task's cwd, probing it once at validate time, and the injectable io
// seam the loader and normalizer share.

import { spawnSync as nodeSpawnSync } from "node:child_process";
import { basename } from "node:path";
import { checkoutToplevel } from "./worktree.mjs";

function namesEqual(a, b) {
  return process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
}

// The MAIN worktree of the repo containing `cwd`, or null when git fails (not a
// repo, git missing) or the repo is bare — the real implementation behind
// io.repoToplevel.
//
// Files the RUN, so NOT `--show-toplevel`: a linked worktree answers that with ITSELF and
// nested run homes inside each other. A writer's tree depth is `checkoutToplevel`'s job.
// `worktree list` names the main worktree first by definition, and survives
// --separate-git-dir where stripping `.git` off --git-common-dir would not.
export function realRepoToplevel(cwd) {
  const result = nodeSpawnSync("git", ["worktree", "list", "--porcelain"], { cwd, encoding: "utf8" });
  if (result.status !== 0 || !result.stdout) return null;
  // Blocks are blank-line separated; only the first one describes the main worktree.
  const block = result.stdout.trim().split(/\r?\n/);
  const end = block.indexOf("");
  const main = end === -1 ? block : block.slice(0, end);
  // A bare repo has no checkout to file a run under; --show-toplevel failed here too.
  if (main.includes("bare")) return null;
  const match = /^worktree (.+)$/.exec(main[0] || "");
  return match ? match[1].trim() : null;
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

export function defaultManifestIo() {
  return {
    spawnSync: (command, opts) => nodeSpawnSync(command, { shell: true, encoding: "utf8", ...opts }),
    stdout: (line) => console.log(line),
    repoToplevel: realRepoToplevel,
    checkoutToplevel,
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
