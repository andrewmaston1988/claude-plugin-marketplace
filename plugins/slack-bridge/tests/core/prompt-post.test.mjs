// A terminal prompt retries plain only when Slack itself refused the custom
// identity: after a timeout the first post may have landed.
import { test } from "node:test";
import assert from "node:assert/strict";
import { postTerminalPrompt } from "../../src/core/prompt-post.mjs";

const config = { remote: { operatorName: "Andrew" } };
const log = { warn: () => {} };

function web(firstError) {
  const posts = [];
  return {
    posts,
    chatPostMessage: async (p) => {
      posts.push(p);
      if (posts.length === 1) throw firstError;
      return { ok: true };
    },
  };
}

test("a Slack refusal of the custom identity retries once as the plain post", async () => {
  const w = web(Object.assign(new Error("invalid_arguments"), { slackError: "invalid_arguments" }));
  assert.equal(await postTerminalPrompt({ web: w, channel: "C1", text: "hi", config, log }), true);
  assert.deepEqual(w.posts.map((p) => p.text), ["hi", "⌨️ hi"]);
});

test("a timeout does not retry: the first post may have landed", async () => {
  const w = web(Object.assign(new Error("The operation was aborted due to timeout"), { name: "TimeoutError" }));
  assert.equal(await postTerminalPrompt({ web: w, channel: "C1", text: "hi", config, log }), false);
  assert.equal(w.posts.length, 1);
});
