// The daemon drops a status whose hook started before the turn ended, so the
// prompt, the status and the turn-end each carry when their hook started.
import { test } from "node:test";
import assert from "node:assert/strict";
import { setup, prime, fakeClient, hook, toolEntry } from "./stop-hook-harness.mjs";

const BASH = { name: "Bash", input: { command: "npm test" }, id: "ta1" };

for (const [name, opts, kind] of [
  ["a typed prompt", { event: "UserPromptSubmit", prompt: "run it" }, "prompt"],
  ["a tool's status", { event: "PreToolUse", toolStart: true, tool: BASH }, "status"],
  ["Stop's turn-end", {}, "turn-end"],
  ["StopFailure's turn-end", { event: "StopFailure" }, "turn-end"],
  ["the idle prompt's turn-end", { event: "Notification", notificationType: "idle_prompt" }, "turn-end"],
]) {
  test(`${name} carries the time its hook started`, async (t) => {
    const env = setup(t);
    await prime(env);
    env.append(toolEntry("a1", "Bash", BASH.input));
    const client = fakeClient();
    // Every reading is a second later than the last, so only the hook's first one
    // matches: a stamp taken at send time would not.
    let clock = 5_000;
    const now = () => (clock += 1_000) - 1_000;
    await hook(env, client, { ...opts, now });
    const sent = client.sends.find((s) => s.kind === kind);
    assert.equal(sent.hookStartedAt, 5_000, JSON.stringify(sent));
  });
}
