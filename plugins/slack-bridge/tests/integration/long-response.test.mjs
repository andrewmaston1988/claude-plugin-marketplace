import { test } from "node:test";
import assert from "node:assert/strict";
import { startTestBridge, waitFor } from "./helpers.mjs";

test("long response (>3000 chars) splits into multiple posts", async (t) => {
  // Generate a response that exceeds the 3000-char limit
  const longResponse = "Word ".repeat(700).trim(); // ~3500 chars

  const { mock, stop } = await startTestBridge({ mockResponse: longResponse });
  t.after(stop);

  mock.send({
    envelope_id: "env-long",
    type: "events_api",
    payload: {
      event: {
        type: "message",
        channel: "C-long",
        channel_type: "channel",
        text: "Give me a long answer",
        ts: "1700000010.000001",
        client_msg_id: "msg-long-001",
      },
    },
  });

  // Should see a placeholder (1 post), then a delete, then multiple posts
  await waitFor(() => mock.deleted().length >= 1 && mock.posted().length >= 3, 6000);

  // Total posted = 1 placeholder + N chunks
  const chunks = mock.posted().slice(1); // skip placeholder
  assert.ok(chunks.length >= 2, `Expected ≥2 chunks, got ${chunks.length}`);

  const totalLen = chunks.reduce((s, c) => s + (c.text?.length ?? 0), 0);
  assert.ok(totalLen > 3000, `Chunks should cover full response, total=${totalLen}`);
});
