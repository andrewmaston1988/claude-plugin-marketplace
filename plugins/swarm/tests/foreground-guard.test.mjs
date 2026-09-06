import { test } from "node:test";
import { equal, ok, match } from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { decide } from "../hooks/foreground-guard.mjs";

const bg = { tool_name: "Bash", tool_input: { command: "node --test", run_in_background: true } };
const fg = { tool_name: "Bash", tool_input: { command: "node --test", timeout: 600000 } };
const leaf = { SWARM_LEAF: "1" };

test("deny fires on a backgrounded Bash call inside a leaf", () => {
  const out = decide({ env: leaf, payload: bg });
  equal(out.hookSpecificOutput.hookEventName, "PreToolUse");
  equal(out.hookSpecificOutput.permissionDecision, "deny");
  // The reason IS the teaching surface — it must name the ceiling, or the leaf's
  // next attempt is the same call with the same 120s default.
  match(out.hookSpecificOutput.permissionDecisionReason, /600000/);
});

test("permits the identical call outside a leaf — the false-positive guard", () => {
  // Backgrounding long commands is standing policy in the operator's own session.
  // A deny leaking there breaks it, and no test of the deny path would notice.
  equal(decide({ env: {}, payload: bg }), null);
  equal(decide({ env: { SWARM_LEAF: "0" }, payload: bg }), null);
  equal(decide({ env: { SWARM_LEAF: "true" }, payload: bg }), null);
});

test("permits a foreground call, and every non-Bash tool", () => {
  equal(decide({ env: leaf, payload: fg }), null);
  equal(decide({ env: leaf, payload: { tool_name: "Bash", tool_input: {} } }), null);
  equal(decide({ env: leaf, payload: { tool_name: "Task", tool_input: { run_in_background: true } } }), null);
  equal(decide({ env: leaf, payload: { tool_name: "Write", tool_input: { file_path: "x" } } }), null);
});

test("fails open on anything malformed — a broken guard must never wedge a leaf", () => {
  for (const payload of [null, undefined, {}, "string", 42, [], { tool_name: "Bash" }, { tool_input: bg.tool_input }]) {
    equal(decide({ env: leaf, payload }), null, JSON.stringify(payload) ?? "undefined");
  }
  // run_in_background must be exactly true — a truthy string is not the harness's shape
  equal(decide({ env: leaf, payload: { tool_name: "Bash", tool_input: { run_in_background: "yes" } } }), null);
  equal(decide(), null);
});

test("the guard shares the ONE Bash matcher entry with the dispatch gate", () => {
  const hooks = JSON.parse(readFileSync(new URL("../hooks/hooks.json", import.meta.url), "utf8"));
  const bashEntries = (hooks.hooks.PreToolUse || []).filter((e) => e.matcher === "Bash");
  // Exactly one entry, both commands inside its `hooks` array. Two entries sharing a
  // matcher would depend on the harness running every match rather than the first —
  // unverified, and a wrong guess there silently disables one of the two.
  equal(bashEntries.length, 1, "one Bash PreToolUse entry, not two competing ones");
  const commands = bashEntries[0].hooks.map((h) => h.command);
  ok(commands.some((c) => c.includes("foreground-guard.mjs")), "the guard must be registered");
  ok(commands.some((c) => c.includes("dispatch-gate.mjs")), "the dispatch gate must survive");
});
