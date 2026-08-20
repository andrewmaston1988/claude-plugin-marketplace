#!/usr/bin/env node
// PreToolUse hook on Bash: guards `swarm.mjs run` — the only subcommand that spends.
//
// Every swarm rule lives in SKILL.md prose, so the rulebook is opt-in: a session
// that runs the engine from a raw command inherited via a STATE handover meets none
// of it. That is not hypothetical — it is the observed vector, and it is
// self-propagating, because such a session writes the same raw command into its own
// handover. A rule that must be read to apply cannot defend against not being read.
//
// So the gate keys on the command, which every path through the bypass has in common:
// dispatching the engine requires the skill to have been invoked this session (its
// offer gate is the user's only consent to spend), and requires the dispatch to be
// bare and backgrounded (a pipe or redirect buffers the stream, and the live frames
// are the operator's only view of a run that may spend millions of tokens).
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const SWARM_HOME = process.env.SWARM_HOME || path.join(os.homedir(), ".swarm");

export function markerPath(sessionId, home = SWARM_HOME) {
  return path.join(home, `.skill-ack-${sessionId}`);
}

// `swarm.mjs run` — path may be quoted, either slash style, with flags after.
//
// The engine must be in EXECUTABLE POSITION: at the start of the command or right
// after a shell separator (`;` `&&` `||` `|` `(`), preceded by its interpreter.
// Matching the bare string anywhere blocked five consecutive non-executing commands
// on 2026-08-20 — a grep searching for it, a heredoc documenting it, a pipeline
// grep, a comment, and the gate's own probe script. Over-blocking is not the safe
// direction: it makes the gate untestable through Bash and teaches the model to
// route around a safety control to do ordinary work.
// Wrappers that precede the interpreter without changing what is executed.
const WRAPPER = "(?:(?:nohup|command|exec|time|env|setsid)\\s+(?:-\\S+\\s+|\\w+=\\S+\\s+)*)*";
const DISPATCH_RE = new RegExp(
  `(?:^|[;&|(]|&&|\\|\\|)\\s*${WRAPPER}` +
    `(?:[\\w./\\\\-]*\\bnode(?:\\.exe)?\\b|["'][^"']*node[^"']*["'])` +
    `\\s+["']?[^"'\\s]*swarm\\.mjs["']?\\s+run\\b`,
);

// A `#` comment: everything after it is inert.
function stripComment(cmd) {
  const i = cmd.indexOf("#");
  return i === -1 ? cmd : cmd.slice(0, i);
}

// Shell decorations that steal the stream from the operator.
const PIPE_RE = /\|/;
const REDIRECT_RE = /\d?>>?(?![=])/; // > >> 2> — not >=
const NOHUP_RE = /(^|\s|;|&&)nohup\s/;
const TRAILING_AMP_RE = /&\s*$/;

const SKILL_HINT =
  'Invoke Skill(swarm:swarm) first — it carries the offer gate (the user must approve the manifest and model mix BEFORE anything spends) and the dispatch rules. The skill was not invoked in this session. If you inherited this command from a handover or a previous session, that is exactly the case this gate exists for: the command came without the rules that govern it.';

const BARE_HINT =
  'Dispatch the engine BARE via Bash with run_in_background: true — no pipe, no redirect, no nohup, no trailing &. The live progress frames are the operator\'s only view of a run that may spend millions of tokens, and a decorated dispatch buffers them into nothing. "Keeping the tool result tidy" is already solved by run_in_background: the frames never enter the transcript.';

// Pure decision, so the harness is not needed to test it.
export function gateDispatch({ command, runInBackground, markerExists }) {
  const cmd = String(command || "");
  if (!DISPATCH_RE.test(stripComment(cmd))) return { block: false };

  if (!markerExists) {
    return { block: true, reason: `A swarm run requires the swarm skill. ${SKILL_HINT}` };
  }

  const offences = [];
  if (PIPE_RE.test(cmd)) offences.push("a pipe (|)");
  if (REDIRECT_RE.test(cmd)) offences.push("a redirect (> / >> / 2>&1)");
  if (NOHUP_RE.test(cmd)) offences.push("nohup");
  if (TRAILING_AMP_RE.test(cmd)) offences.push("a trailing & (shell background)");
  if (offences.length) {
    return {
      block: true,
      reason: `This swarm dispatch is decorated with ${offences.join(" and ")}. ${BARE_HINT}`,
    };
  }

  if (runInBackground !== true) {
    return {
      block: true,
      reason: `This swarm dispatch is in the foreground: it will block the session for the length of the run and bury the live frames in a tool result — the same harm as a pipe. Re-issue it with run_in_background: true. ${BARE_HINT}`,
    };
  }

  // One skill invocation authorises one dispatch. A second wave is a fresh spend and
  // must meet the offer gate again.
  return { block: false, consumeMarker: true };
}

async function main() {
  let stdin = "";
  process.stdin.setEncoding("utf8");
  for await (const c of process.stdin) stdin += c;

  let payload;
  try { payload = JSON.parse(stdin); } catch { process.exit(0); } // fail open

  const input = payload?.tool_input || {};
  const sessionId = String(payload?.session_id || "");
  if (!sessionId) process.exit(0); // fail open — cannot locate a marker without it

  const marker = markerPath(sessionId);
  const decision = gateDispatch({
    command: input.command,
    runInBackground: input.run_in_background === true,
    markerExists: fs.existsSync(marker),
  });

  if (decision.block) {
    process.stdout.write(JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: decision.reason,
      },
    }));
    process.exit(0);
  }

  if (decision.consumeMarker) {
    try { fs.unlinkSync(marker); } catch { /* already gone — the dispatch still passes */ }
  }
  process.exit(0);
}

// Only run as a hook, never on import from the tests.
if (process.argv[1] && import.meta.url.endsWith(path.basename(process.argv[1]))) {
  main().catch(() => process.exit(0)); // never wedge the session
}
