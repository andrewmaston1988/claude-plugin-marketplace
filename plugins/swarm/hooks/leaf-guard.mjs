#!/usr/bin/env node
// PreToolUse hook, no matcher: run a project-owned guard script before every tool
// call inside a swarm leaf, and deny the call when the guard says no.
//
// Why this exists: `allowedTools` scopes tool NAMES, not what a tool is asked to
// do, and prompt prose ("only run the narrow test command") is not enforcement.
// Observed: three parallel leaves each cold-compiled a multi-GB dependency tree
// in their own worktrees despite prose forbidding it — tens of GB of build output
// and a commit-charge peak that got every engine on the machine killed. A repo's
// own policy script, wired per-project via `~/.swarm/config.json` `projects[].hooks.preToolUse`,
// reaches this hook as `SWARM_LEAF_GUARD` in the spawn env (src/scheduler.mjs),
// set only for a leaf whose repo name (from `originalCwd`) matched that project's
// `name` — the repo decides what its leaves may not do, once, instead of every
// manifest author.
//
// Fail-CLOSED, unlike `foreground-guard.mjs`'s fail-open. That guard's failure mode
// is a lost leaf (annoying, cheap to retry); this guard's failure mode of failing
// open is the 50 GB again. So: guard exits 2 -> deny with its stderr. Any other
// outcome -- non-2/non-0 exit, timeout, spawn error, unparseable stdin -- is ALSO a
// deny, naming what went wrong. A leaf denied on every call ends loud and fast,
// which is the point: silent allow is exactly the bug this hook was written to stop.
//
// Runs on every tool (no matcher), because a guard may need to inspect any
// tool_input, not just Bash's -- but exits before touching stdin unless both
// SWARM_LEAF=1 and SWARM_LEAF_GUARD are set, so a non-leaf session (and a leaf
// whose project has no configured guard) never spawns the extra process.

import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";

function deny(reason) {
  return {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: reason,
    },
  };
}

// Pure over (env, payload, an injected run) so it is testable without a real
// subprocess. null = allow. Every path that is not an explicit exit-0 from the
// guard returns a deny -- fail-closed is the contract here, not a fallback.
export function decide({ env = process.env, payload, run, cwd = process.cwd() } = {}) {
  if (env?.SWARM_LEAF !== "1") return null; // not a leaf -- allow
  const command = env?.SWARM_LEAF_GUARD;
  if (!command) return null; // leaf has no configured guard -- allow

  if (payload == null || typeof payload !== "object") {
    return deny(`leaf guard "${command}" denied: could not parse the tool call payload (fail-closed)`);
  }

  const result = run({ command, input: JSON.stringify(payload), cwd });

  if (result?.error) {
    return deny(`leaf guard "${command}" failed to run: ${result.error}`);
  }
  if (result?.status === 0) return null;

  const stderr = (result?.stderr ?? "").toString().trim();
  if (result?.status === 2) {
    return deny(stderr || `leaf guard "${command}" denied the call (exit 2, no message)`);
  }
  return deny(`leaf guard "${command}" exited ${result?.status}: ${stderr || "(no stderr)"}`);
}

function realRun({ command, input, cwd }) {
  const result = spawnSync(command, { shell: true, cwd, input, timeout: 5000, encoding: "utf8" });
  if (result.error) return { error: result.error.code || result.error.message };
  return { status: result.status, stderr: result.stderr ?? "" };
}

async function main() {
  try {
    // Checked before stdin so a non-leaf session, or a leaf with no configured
    // guard, never blocks on a read it will ignore.
    if (process.env.SWARM_LEAF !== "1" || !process.env.SWARM_LEAF_GUARD) {
      process.exit(0);
      return;
    }

    let stdin = "";
    process.stdin.setEncoding("utf8");
    for await (const c of process.stdin) stdin += c;

    let payload = null;
    try { payload = JSON.parse(stdin); } catch { /* fail-closed via decide */ }

    const out = decide({ env: process.env, payload, run: realRun, cwd: process.cwd() });
    if (out) process.stdout.write(JSON.stringify(out));
    process.exit(0);
  } catch (err) {
    // Fail-closed even on our own bug: a crashed hook must still deny, never
    // silently allow the call through.
    process.stdout.write(JSON.stringify(deny(`leaf guard hook crashed: ${err?.message ?? String(err)}`)));
    process.exit(0);
  }
}

// Entry-point guard: importing this for its `decide` must not start reading stdin.
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main();
}
