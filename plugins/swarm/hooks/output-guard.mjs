#!/usr/bin/env node
// PreToolUse hook on Bash and PowerShell: deny a PIPED `swarm validate` or `swarm perf`.
//
// Those two print the seating record — each seat's n, score and frontier verdict — and
// a filter (`grep`, `head`, `tail`, `Select-String`, `Select-Object -First`) can hide
// the one line that says the manifest seats a dominated model. 2026-11-15: seven
// validate calls in one session all ran through `grep -E "manifest OK|error|…"`, and
// the run they authorised seated four cost-dominated models.
//
// A redirect is allowed: the file holds everything and Read-ing it whole is the
// intended use. `||` is not a pipe. Quoted spans are blanked first, on the raw text
// before anything else, so a commit message or an `--args` JSON blob that mentions
// the command is not a filter.
//
// Silent inside a swarm leaf, on the same signal foreground-guard.mjs uses: a leaf's
// own tooling may legitimately parse the record, and a broken guard must never wedge
// it. Fail-open everywhere.

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

// A `|` that is not half of `||`.
function piped(cmd, from) {
  for (let i = from; i < cmd.length; i++) {
    if (cmd[i] !== "|") continue;
    if (cmd[i + 1] === "|" || cmd[i - 1] === "|") continue;
    return true;
  }
  return false;
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
      if (piped(blanked, m.index + m[0].length)) return deny();
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
