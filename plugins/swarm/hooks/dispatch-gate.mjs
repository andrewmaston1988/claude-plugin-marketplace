#!/usr/bin/env node
// PreToolUse hook on Bash: guards the engine's `run` subcommand — the only one
// that spends. It keys on the COMMAND, not on the skill, because a rule that must
// be read to apply cannot defend against not being read: a raw command inherited
// through a handover is bound by nothing in SKILL.md.
//
// A dispatch therefore requires the skill invoked this session (its offer gate is
// the only consent to spend), bare and backgrounded — a pipe or redirect buffers
// the frames that are the operator's only view of the run.
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const SWARM_HOME = process.env.SWARM_HOME || path.join(os.homedir(), ".swarm");

export function markerPath(sessionId, home = SWARM_HOME) {
  return path.join(home, `.skill-ack-${sessionId}`);
}

// The engine must be in EXECUTABLE POSITION — start of command, after a
// separator, or after a keyword that introduces one — preceded by its
// interpreter. Matching the bare string anywhere blocks ordinary work: a grep
// for it, a heredoc documenting it, a comment, the gate's own tests. That is not
// the safe direction, because it makes the gate untestable through Bash and
// teaches routing around a safety control.
//
// Anchors must cover every position a command can START at, not the ones that
// came to mind: `\n` and backtick belong here as much as `;` and `&&`.
const ANCHOR = "(?:^|[;&|(`\\n]|&&|\\|\\||\\b(?:then|do|else|elif)\\b|\\{)";

// Wrappers that precede the interpreter without changing what is executed.
const WRAPPER = "(?:(?:nohup|command|exec|time|env|setsid)\\s+(?:-\\S+\\s+|\\w+=\\S+\\s+)*)*";
const DISPATCH_RE = new RegExp(
  `${ANCHOR}\\s*${WRAPPER}` +
    `(?:[\\w./\\\\-]*\\bnode(?:\\.exe)?\\b|["'][^"']*node[^"']*["'])` +
    `\\s+["']?[^"'\\s]*swarm\\.mjs["']?\\s+run\\b`,
);

// A `#` comment runs to end of LINE, not end of command — cutting at the first
// `#` in a multi-line command would hide a real dispatch on a later line.
// Heredoc bodies are inert too: the shell feeds them to a program's stdin, so a
// command quoted inside one is data, not something that runs.
function stripComment(cmd) {
  const out = [];
  let heredoc = null;
  for (const line of String(cmd).split("\n")) {
    if (heredoc !== null) {
      if (line.trim() === heredoc) heredoc = null;
      continue;
    }
    const open = line.match(/<<-?\s*['"]?([A-Za-z_][A-Za-z0-9_]*)['"]?/);
    const i = line.indexOf("#");
    out.push(i === -1 ? line : line.slice(0, i));
    if (open) heredoc = open[1];
  }
  return out.join("\n");
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
