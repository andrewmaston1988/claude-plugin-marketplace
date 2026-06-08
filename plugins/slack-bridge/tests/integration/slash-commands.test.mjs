import { test } from "node:test";
import assert from "node:assert/strict";
import { startTestBridge, waitFor } from "./helpers.mjs";

test("/new clears session store and posts confirmation", async (t) => {
  const { mock, stop } = await startTestBridge();
  t.after(stop);

  mock.send({
    envelope_id: "env-slash-new",
    type: "slash_commands",
    payload: {
      command: "/new",
      channel_id: "C001",
      text: "",
    },
  });

  await waitFor(() => mock.posted().length >= 1, 3000);
  const msg = mock.posted()[0].text ?? mock.posted()[0].attachments?.[0]?.text ?? "";
  assert.ok(
    msg.toLowerCase().includes("session") || msg.toLowerCase().includes("clear"),
    `Expected session-cleared confirmation, got: ${msg}`,
  );
});

test("/reset is an alias for /new", async (t) => {
  const { mock, stop } = await startTestBridge();
  t.after(stop);

  mock.send({
    envelope_id: "env-slash-reset",
    type: "slash_commands",
    payload: {
      command: "/reset",
      channel_id: "C002",
      text: "",
    },
  });

  await waitFor(() => mock.posted().length >= 1, 3000);
  const msg = mock.posted()[0].text ?? mock.posted()[0].attachments?.[0]?.text ?? "";
  assert.ok(msg.length > 0, "should post confirmation");
});
