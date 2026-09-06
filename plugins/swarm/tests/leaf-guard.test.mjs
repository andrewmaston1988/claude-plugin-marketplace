import { test } from "node:test";
import { equal, ok, match } from "node:assert/strict";
import { readFileSync } from "node:fs";
import { decide } from "../hooks/leaf-guard.mjs";

const leaf = { SWARM_LEAF: "1", SWARM_LEAF_GUARD: "node scripts/guard.mjs" };
const payload = { tool_name: "Bash", tool_input: { command: "cargo test" } };

function neverCalled() {
  throw new Error("run must not be called");
}

test("SWARM_LEAF unset -> allow, run never called", () => {
  const out = decide({ env: {}, payload, run: neverCalled });
  equal(out, null);
});

test("SWARM_LEAF=1 but no SWARM_LEAF_GUARD -> allow, run never called", () => {
  const out = decide({ env: { SWARM_LEAF: "1" }, payload, run: neverCalled });
  equal(out, null);
});

test("guard exits 0 -> allow", () => {
  const out = decide({ env: leaf, payload, run: () => ({ status: 0 }) });
  equal(out, null);
});

test("guard exits 2 with stderr -> deny, reason is exactly the trimmed stderr", () => {
  const out = decide({
    env: leaf,
    payload,
    run: () => ({ status: 2, stderr: "  no cargo in lanes\n" }),
  });
  equal(out.hookSpecificOutput.hookEventName, "PreToolUse");
  equal(out.hookSpecificOutput.permissionDecision, "deny");
  equal(out.hookSpecificOutput.permissionDecisionReason, "no cargo in lanes");
});

test("guard exits 2 with empty stderr -> deny, reason names the guard command", () => {
  const out = decide({ env: leaf, payload, run: () => ({ status: 2, stderr: "" }) });
  equal(out.hookSpecificOutput.permissionDecision, "deny");
  match(out.hookSpecificOutput.permissionDecisionReason, /node scripts\/guard\.mjs/);
});

test("guard exits 1 -> deny, reason quotes exit 1 and stderr", () => {
  const out = decide({
    env: leaf,
    payload,
    run: () => ({ status: 1, stderr: "boom" }),
  });
  equal(out.hookSpecificOutput.permissionDecision, "deny");
  match(out.hookSpecificOutput.permissionDecisionReason, /exited 1/);
  match(out.hookSpecificOutput.permissionDecisionReason, /boom/);
});

test("run reports a timeout/spawn error -> deny, reason names it", () => {
  const out = decide({ env: leaf, payload, run: () => ({ error: "ETIMEDOUT" }) });
  equal(out.hookSpecificOutput.permissionDecision, "deny");
  match(out.hookSpecificOutput.permissionDecisionReason, /ETIMEDOUT/);
});

test("run receives the payload JSON as input and the leaf cwd as cwd", () => {
  let seen = null;
  decide({
    env: leaf,
    payload,
    cwd: "C:/leaf/worktree",
    run: (args) => {
      seen = args;
      return { status: 0 };
    },
  });
  equal(seen.command, "node scripts/guard.mjs");
  equal(seen.input, JSON.stringify(payload));
  equal(seen.cwd, "C:/leaf/worktree");
});

test("unparseable stdin -> deny, fail-closed", () => {
  const out = decide({ env: leaf, payload: null, run: neverCalled });
  equal(out.hookSpecificOutput.permissionDecision, "deny");
});

test("the no-matcher PreToolUse entry runs leaf-guard.mjs before the Bash-matched entries", () => {
  const hooks = JSON.parse(readFileSync(new URL("../hooks/hooks.json", import.meta.url), "utf8"));
  const entries = hooks.hooks.PreToolUse || [];
  const guardIndex = entries.findIndex((e) => !e.matcher && e.hooks.some((h) => h.command.includes("leaf-guard.mjs")));
  ok(guardIndex !== -1, "leaf-guard.mjs must be wired on a no-matcher PreToolUse entry");
  const bashIndex = entries.findIndex((e) => e.matcher === "Bash");
  ok(bashIndex === -1 || guardIndex < bashIndex, "leaf-guard entry must come before the Bash-matched entries");
});
