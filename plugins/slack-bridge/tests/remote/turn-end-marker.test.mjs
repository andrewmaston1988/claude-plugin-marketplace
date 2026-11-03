// The Stop's turn-end marker: the waiter the same Stop starts holds its first take
// until it appears, so the read receipt follows the turn-end.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { SID, fakeClient, hook, prime, setup, textEntry } from "./stop-hook-harness.mjs";

const SPAWNED = 1_800_000_000_000;
const markerFile = (env) => path.join(env.stateDir, "remote-sessions", `${SID}.turn-end`);
const marker = (env) => (fs.existsSync(markerFile(env)) ? Number(fs.readFileSync(markerFile(env), "utf8")) : null);

test("a Stop marks its spawn time once its turn-end is sent, not before", async (t) => {
  const env = setup(t);
  await prime(env);
  env.append(textEntry("a1", "Done."));
  let atSend;
  const client = fakeClient({ sendDelay: async () => { atSend ??= marker(env); } });
  await hook(env, client, { lastMessage: "Done.", spawnedAt: SPAWNED });
  assert.ok(client.sends.some((s) => s.kind === "turn-end"));
  assert.equal(atSend, null, "no marker while the turn-end is in flight");
  assert.equal(marker(env), SPAWNED);
});

test("a failed turn-end still marks, so the waiter is not held to its bound", async (t) => {
  const env = setup(t);
  await prime(env);
  await hook(env, fakeClient({ fail: true }), { spawnedAt: SPAWNED });
  assert.equal(marker(env), SPAWNED);
});

test("only a Stop marks", async (t) => {
  const env = setup(t);
  await prime(env);
  const tool = { name: "Bash", input: { command: "ls" }, id: "tb1" };
  await hook(env, fakeClient(), { event: "PostToolUse", tool, spawnedAt: SPAWNED });
  let clock = 0;
  await hook(env, fakeClient(), { event: "PreToolUse", tool, toolStart: true, spawnedAt: SPAWNED, sleep: async () => {}, now: () => (clock += 1_000) });
  await hook(env, fakeClient(), { event: "UserPromptSubmit", prompt: "hi", spawnedAt: SPAWNED });
  assert.equal(marker(env), null);
});
