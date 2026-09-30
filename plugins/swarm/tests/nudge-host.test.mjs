import { test } from "node:test";
import { deepEqual, equal } from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { nudgeEventFor, nudgeOutput } from "../hooks/nudge-host.mjs";

const CODEX = { turn_id: "turn-1", model: "gpt-6-luna" };
const CLAUDE = {};
const ROOT = fileURLToPath(new URL("..", import.meta.url));

test("routes Codex to Stop and Claude by entrypoint", () => {
  equal(nudgeEventFor(CODEX, {}), "Stop");
  equal(nudgeEventFor(CLAUDE, { CLAUDE_CODE_ENTRYPOINT: "sdk-cli" }), "Stop");
  equal(nudgeEventFor(CLAUDE, { CLAUDE_CODE_ENTRYPOINT: "cli" }), "UserPromptSubmit");
  equal(nudgeEventFor(CLAUDE, {}), "UserPromptSubmit");
});

test("formats host-specific nudge output", () => {
  deepEqual(nudgeOutput(CODEX, {}, "literal reason"), { decision: "block", reason: "literal reason" });
  deepEqual(nudgeOutput(CLAUDE, { CLAUDE_CODE_ENTRYPOINT: "sdk-cli" }, "literal reason"), { decision: "block", reason: "literal reason" });
  deepEqual(nudgeOutput(CLAUDE, { CLAUDE_CODE_ENTRYPOINT: "cli" }, "literal reason"), {
    hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: "literal reason" },
  });
});
test("hooks.json registers both nudges for both events", () => {
  const hooks = JSON.parse(readFileSync(`${ROOT}/hooks/hooks.json`, "utf8")).hooks;
  for (const event of ["UserPromptSubmit", "Stop"]) {
    const commands = hooks[event].flatMap((entry) => entry.hooks.map((hook) => hook.command));
    equal(commands.includes('node "${CLAUDE_PLUGIN_ROOT}/hooks/grade-nudge.mjs"'), true, `${event} grade nudge`);
    equal(commands.includes('node "${CLAUDE_PLUGIN_ROOT}/hooks/prune-nudge.mjs"'), true, `${event} prune nudge`);
  }
});