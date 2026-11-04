// An API error and Esc start no waiter, so their turn-end says why: the daemon tells
// the operator a queued message stays queued. A Stop's waiter takes it, so no reason.
import { test } from "node:test";
import assert from "node:assert/strict";
import { setup, prime, fakeClient, hook } from "./stop-hook-harness.mjs";

for (const [name, opts, why] of [
  ["a Stop", {}, ""],
  ["StopFailure", { event: "StopFailure", lastMessage: "API Error: overloaded" }, "The session stopped on an API error."],
  ["the idle prompt", { event: "Notification", notificationType: "idle_prompt" }, "The session is idle and not listening."],
]) {
  test(`${name} ends the turn${why ? " and says why" : " with no reason"}`, async (t) => {
    const env = setup(t);
    await prime(env);
    const client = fakeClient();
    await hook(env, client, opts);
    assert.deepEqual(client.sends.filter((s) => s.kind === "turn-end").map((s) => s.text), [why]);
  });
}

test("any other notification ends nothing", async (t) => {
  const env = setup(t);
  await prime(env);
  const client = fakeClient();
  await hook(env, client, { event: "Notification", notificationType: "permission_prompt" });
  assert.deepEqual(client.sends, []);
});
