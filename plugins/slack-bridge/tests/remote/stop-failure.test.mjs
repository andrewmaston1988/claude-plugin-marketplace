// An API error ends a turn with StopFailure instead of Stop. Without a turn-end
// the turn's block would tick on until the next turn or the ceiling.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { SID, setup, prime, fakeClient, hook, textEntry } from "./stop-hook-harness.mjs";

test("StopFailure mirrors the turn's text, then sends turn-end without waiting on the error message", async (t) => {
  const env = setup(t);
  await prime(env);
  env.append(textEntry("a1", "halfway there"));
  const client = fakeClient();
  const sleeps = [];
  await hook(env, client, { event: "StopFailure", lastMessage: "API Error: overloaded", sleeps });
  assert.deepEqual(client.sends.map((s) => [s.kind, s.text]), [["text", "halfway there"], ["turn-end", ""]]);
  assert.deepEqual(sleeps, []);
});

test("StopFailure writes no turn-end marker: no waiter starts to read it", async (t) => {
  const env = setup(t);
  await prime(env);
  await hook(env, fakeClient(), { event: "StopFailure" });
  assert.equal(fs.existsSync(path.join(env.stateDir, "remote-sessions", `${SID}.turn-end`)), false);
});

test("hooks.json runs the stop-hook on StopFailure", () => {
  const file = fileURLToPath(new URL("../../hooks/hooks.json", import.meta.url));
  const commands = JSON.parse(fs.readFileSync(file, "utf8")).hooks.StopFailure.flatMap((g) => g.hooks.map((h) => h.command));
  assert.deepEqual(commands, ['node "${CLAUDE_PLUGIN_ROOT}/bin/claude-slack.mjs" stop-hook']);
});
