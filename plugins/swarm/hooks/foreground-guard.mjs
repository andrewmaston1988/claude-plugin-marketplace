#!/usr/bin/env node
// PreToolUse hook on Bash: deny `run_in_background` inside swarm LEAVES.
//
// Written 2026-09-01 as an unwired stub, wired 2026-09-06 after the same death
// recurred — four dev leaves in one night, none of which committed its work.
// The record below is why it exists; keep it.
//
// Why: a headless leaf (`claude -p`) that backgrounds a command and yields the
// turn is OVER — the task-notification re-invoke that makes backgrounding safe
// in interactive sessions never fires in -p mode, and the harness kills the
// background task at session teardown. Six leaves died exactly this way in one
// tranche (2026-09-01, primordial M4): each backgrounded `cargo test`, ended
// its turn "waiting for the notification", and reported `ok` with the tree
// dirty. Transcript signature: result record with `is_error:false,
// api_error_status:null, terminal_reason:"completed"`, followed by
// `task_updated {"status":"killed"}` on the still-running cargo task.
// Prompt-level prohibitions work but must be repeated in every manifest; this
// hook is the mechanical version.
//
// Why a hook and not permissions: `--allowedTools`/`--disallowedTools` match
// tools and command patterns; `run_in_background` is a tool-INPUT field on
// Bash, invisible to permission rules. A PreToolUse hook receives the full
// tool_input and can deny on it. And not user settings.json: that would fire
// in the operator's interactive sessions too, where backgrounding long
// commands is standing policy — the plugin hook plus a leaf marker scopes it.
//
// Leaf discrimination: plugin hooks load in every session on the machine,
// `claude -p` leaves included (observed: the checkpoint plugin's SessionStart
// resume hook fires in swarm leaves). So the deny fires only when the leaf
// marker env var is present — `SWARM_LEAF`, set in the spawn env merge in
// src/scheduler.mjs beside CORRELATION_ID. (CORRELATION_ID is NOT a safe
// discriminator — it is only defaulted to `swarm:<taskId>` when the dispatching
// environment lacks one, so a set value can leak through from the parent session
// and would arm the deny in the operator's own interactive session.)
//
// What this does NOT cover: a FOREGROUND Bash call that exceeds its timeout is
// auto-backgrounded by the harness, with the same fatal result and no
// `run_in_background` field for any hook to see. Only the leaf-shape prompt in
// skills/swarm/SKILL.md addresses that, by naming the 600000 ms ceiling. This
// hook reduces the failure surface; it does not close it.
//
// Fail-open everywhere: a broken guard must never wedge a leaf.

import { pathToFileURL } from "node:url";

// The whole decision, pure over (env, payload) so it is testable without stdin or a
// subprocess — the shape ultraswarm.mjs uses. null = allow. Every rejection path
// returns null rather than throwing: fail-open is the contract, not a fallback.
export function decide({ env = process.env, payload } = {}) {
  if (env?.SWARM_LEAF !== "1") return null;                      // not a leaf — allow
  if (payload?.tool_name !== "Bash") return null;                // wrong tool, or unparseable stdin
  if (payload?.tool_input?.run_in_background !== true) return null; // exactly true, never truthy
  return {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason:
        "This is a headless swarm leaf: a backgrounded command dies with the " +
        "session — the completion notification you are waiting for will never " +
        "arrive, and yielding the turn ENDS your session with the work lost. " +
        "Re-run this exact command in the FOREGROUND with an adequate timeout " +
        "(up to 600000 ms) and wait for it.",
    },
  };
}

async function main() {
  // Checked before stdin so a non-leaf session never blocks on a read it will ignore.
  if (process.env.SWARM_LEAF !== "1") process.exit(0);

  let stdin = "";
  process.stdin.setEncoding("utf8");
  for await (const c of process.stdin) stdin += c;

  let payload = null;
  try { payload = JSON.parse(stdin); } catch { /* fail open via decide */ }

  const out = decide({ env: process.env, payload });
  if (out) process.stdout.write(JSON.stringify(out));
  process.exit(0);
}

// Entry-point guard: importing this for its `decide` must not start reading stdin.
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch(() => process.exit(0)); // never wedge the session
}
