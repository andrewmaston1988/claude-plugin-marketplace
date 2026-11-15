import "./helpers/isolate-home.mjs";
import { test } from "node:test";
import { equal, ok } from "node:assert/strict";
import { readFileSync } from "node:fs";
import { decide } from "../hooks/output-guard.mjs";

// `swarm validate` and `swarm perf` print the seating record. 2026-11-15: every
// validate in one session was piped through `grep -E "manifest OK|error|estimated|  - "`
// and the run it authorised seated four cost-dominated models. The guard keys on the
// pipe, not on the filter's name: `head`, `tail` and `Select-String` hide output the
// same way `grep` does.

const call = (tool, command) => ({ tool_name: tool, tool_input: { command } });

const DENY_REASON =
  "swarm validate/perf output is the seating record — run it bare and read all of it; to keep it, redirect to a file (> out.txt) and Read the file whole";

const DENIED = [
  "swarm validate m.json | grep OK",
  "swarm perf --overall 2>&1 | head -30",
  "node C:/x/swarm.mjs perf | grep kimi",
  "swarm.cmd validate m.json | Select-String OK",
  "cd repo && swarm validate m.json | tail -3",
];

const ALLOWED = [
  "swarm validate m.json",
  "swarm perf --overall",
  "swarm validate m.json > out.txt",
  // Quoted: a commit message, and an --args blob whose value contains a pipe.
  'git commit -m "swarm perf | grep"',
  `swarm validate m.json --args '{"x":"a|b"}'`,
  'swarm validate m.json --args "{\\"x\\":\\"a|b\\"}"',
  // `||` is a conditional, not a filter.
  "swarm validate m.json || echo failed",
  // Other subcommands are untouched.
  "swarm status run | tail",
];

test("row 13: denies a piped validate or perf, on Bash and on PowerShell", () => {
  for (const tool of ["Bash", "PowerShell"]) {
    for (const command of DENIED) {
      const out = decide({ env: {}, payload: call(tool, command) });
      equal(out?.hookSpecificOutput?.permissionDecision, "deny", `${tool} must deny: ${command}`);
    }
  }
});

test("row 13: the deny message is the one the plan fixes, verbatim", () => {
  const out = decide({ env: {}, payload: call("Bash", DENIED[0]) });
  equal(out.hookSpecificOutput.permissionDecisionReason, DENY_REASON);
});

test("row 13: allows the bare read, a redirect, quoted mentions, `||`, and other subcommands", () => {
  for (const tool of ["Bash", "PowerShell"]) {
    for (const command of ALLOWED) {
      equal(decide({ env: {}, payload: call(tool, command) }), null, `${tool} must allow: ${command}`);
    }
  }
});

// A quoted engine path must still count: the subcommand match runs on the raw text,
// only the pipe scan runs on the blanked copy.
test("row 13: a quoted engine path before a real pipe is still denied", () => {
  const out = decide({ env: {}, payload: call("Bash", 'node "C:/x/swarm.mjs" perf | grep kimi') });
  equal(out?.hookSpecificOutput?.permissionDecision, "deny");
});

// A leaf's own tooling may legitimately parse the record, and a broken guard must
// never wedge a leaf — the same SWARM_LEAF signal foreground-guard.mjs reads.
test("row 14: silent inside a swarm leaf, still denying outside one", () => {
  const payload = call("Bash", "swarm perf --overall | head -30");
  equal(decide({ env: { SWARM_LEAF: "1" }, payload }), null);
  equal(decide({ env: { SWARM_LEAF: "0" }, payload })?.hookSpecificOutput?.permissionDecision, "deny");
  equal(decide({ env: {}, payload })?.hookSpecificOutput?.permissionDecision, "deny");
});

test("fails open on anything malformed — a broken guard must never wedge the session", () => {
  for (const payload of [
    null,
    undefined,
    {},
    "string",
    42,
    [],
    { tool_name: "Bash" },
    { tool_name: "Bash", tool_input: { command: "" } },
    { tool_name: "Read", tool_input: { command: "swarm perf | head" } },
    { tool_name: "Bash", tool_input: { command: 42 } },
  ]) {
    equal(decide({ env: {}, payload }), null, JSON.stringify(payload) ?? "undefined");
  }
  equal(decide(), null);
});

test("hooks.json registers the guard on a PreToolUse Bash|PowerShell entry", () => {
  const hooks = JSON.parse(readFileSync(new URL("../hooks/hooks.json", import.meta.url), "utf8")).hooks;
  const entries = (hooks.PreToolUse || []).filter((e) => e.matcher === "Bash|PowerShell");
  equal(entries.length, 1, "one Bash|PowerShell PreToolUse entry");
  const commands = entries[0].hooks.map((h) => h.command);
  ok(commands.some((c) => c.includes("output-guard.mjs")), "the output guard must be registered");
  // The Bash-only entry must keep its own two hooks — a guard added here must not
  // have been moved into (or out of) it.
  const bash = (hooks.PreToolUse || []).filter((e) => e.matcher === "Bash");
  equal(bash.length, 1, "the Bash-only entry stays exactly one");
  const bashCommands = bash[0].hooks.map((h) => h.command);
  ok(bashCommands.some((c) => c.includes("dispatch-gate.mjs")), "the dispatch gate must survive");
  ok(bashCommands.some((c) => c.includes("foreground-guard.mjs")), "the foreground guard must survive");
});
