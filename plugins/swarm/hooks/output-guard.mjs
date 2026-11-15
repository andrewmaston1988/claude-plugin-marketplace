#!/usr/bin/env node
// PreToolUse hook on Bash and PowerShell: deny a PIPED `swarm validate` or `swarm perf` —
// they print the seating record, and a filter can hide the one line that matters.
// A redirect is allowed; quoted spans are blanked first so a mention is no match.
// Silent inside a swarm leaf. Fail-open everywhere.

import { pathToFileURL } from "node:url";
import { swarmSubcommandRe } from "./swarm-command.mjs";

const DENY_REASON =
  "swarm validate/perf output is the seating record — run it bare and read all of it; to keep it, redirect to a file (> out.txt) and Read the file whole";

const GUARDED = ["validate", "perf"];

// Replace every quoted span with spaces, keeping indices. Here-strings are matched
// first: their `@'` / `@"` opener would otherwise read as an empty single/double quote
// pair. Backslash escapes inside double quotes, and a doubled `''` inside single
// quotes, are skipped so the span closes where the shell closes it.
function blankQuoted(command) {
  const s = String(command);
  const out = [...s];
  const blank = (from, to) => {
    for (let i = from; i < to && i < out.length; i++) if (out[i] !== "\n" && out[i] !== "\r") out[i] = " ";
  };
  let i = 0;
  while (i < s.length) {
    const q = s[i];
    if (q === "@" && (s[i + 1] === "'" || s[i + 1] === '"')) {
      const end = s.indexOf(`\n${s[i + 1]}@`, i + 2);
      const stop = end === -1 ? s.length : end + 3;
      blank(i, stop);
      i = stop;
      continue;
    }
    if (q === "'") {
      let j = i + 1;
      while (j < s.length && s[j] !== "'") j++;
      blank(i, j + 1);
      i = j + 1;
      continue;
    }
    if (q === '"') {
      let j = i + 1;
      while (j < s.length && s[j] !== '"') j += s[j] === "\\" ? 2 : 1;
      blank(i, j + 1);
      i = j + 1;
      continue;
    }
    i++;
  }
  return out.join("");
}

// Offset of the next statement separator (`;`, `&&`, `||`, line break), or end of input.
function statementEnd(cmd, from) {
  for (let i = from; i < cmd.length; i++) {
    const c = cmd[i];
    if (c === ";" || c === "\n" || c === "\r") return i;
    if ((c === "&" || c === "|") && cmd[i + 1] === c) return i;
  }
  return cmd.length;
}

// A `|` that is not half of `||`, stopping at the statement separator.
function piped(cmd, from) {
  const end = statementEnd(cmd, from);
  for (let i = from; i < end; i++) {
    if (cmd[i] !== "|") continue;
    if (cmd[i + 1] === "|" || cmd[i - 1] === "|") continue;
    return true;
  }
  return false;
}

// A `>(` process substitution — a filter without a pipe.
function processSub(cmd, from) {
  return cmd.slice(from, statementEnd(cmd, from)).includes(">(");
}

function deny() {
  return {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: DENY_REASON,
    },
  };
}

// The whole decision, pure over (env, payload) so it is testable without stdin or a
// subprocess. null = allow; every malformed path allows rather than throwing.
export function decide({ env = process.env, payload } = {}) {
  if (env?.SWARM_LEAF === "1") return null; // leaf — allow
  const tool = payload?.tool_name;
  if (tool !== "Bash" && tool !== "PowerShell") return null;
  const command = payload?.tool_input?.command;
  if (typeof command !== "string" || !command) return null;

  const blanked = blankQuoted(command);
  for (const sub of GUARDED) {
    const re = new RegExp(swarmSubcommandRe(sub).source, "g");
    for (const m of blanked.matchAll(re)) {
      const from = m.index + m[0].length;
      if (piped(blanked, from) || processSub(blanked, from)) return deny();
    }
  }
  return null;
}

async function main() {
  // Checked before stdin so a leaf never blocks on a read it will ignore.
  if (process.env.SWARM_LEAF === "1") process.exit(0);

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
