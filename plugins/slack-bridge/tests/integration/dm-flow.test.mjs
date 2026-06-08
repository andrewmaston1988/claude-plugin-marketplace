import { test } from "node:test";
import assert from "node:assert/strict";
import { startTestBridge, waitFor } from "./helpers.mjs";

test("DM flow — message → claude → response posted", async (t) => {
  const { mock, stop } = await startTestBridge({ mockResponse: "Hello from Claude" });
  t.after(stop);

  // Send a DM event via Socket Mode
  mock.send({
    envelope_id: "env-1",
    type: "events_api",
    payload: {
      event: {
        type: "message",
        channel: "D001",
        channel_type: "im",
        text: "Hello Claude",
        ts: "1700000001.000001",
        client_msg_id: "msg-001",
      },
    },
  });

  // Bridge should post a placeholder then update it with the response
  await waitFor(() => mock.posted().length >= 1, 5000);
  await waitFor(() => mock.updated().length >= 1, 5000);

  const update = mock.updated()[0];
  const attachText = update.attachments?.[0]?.text ?? update.text ?? "";
  assert.ok(
    attachText.includes("Hello from Claude"),
    `Response should contain claude output, got: ${attachText}`,
  );
});

test("DM flow — duplicate client_msg_id is ignored", async (t) => {
  const { mock, stop } = await startTestBridge({ mockResponse: "Response" });
  t.after(stop);

  const event = {
    envelope_id: "env-2",
    type: "events_api",
    payload: {
      event: {
        type: "message",
        channel: "D002",
        channel_type: "im",
        text: "Duplicate",
        ts: "1700000002.000001",
        client_msg_id: "msg-dup-001",
      },
    },
  };

  mock.send(event);
  await waitFor(() => mock.posted().length >= 1, 5000);
  const countAfterFirst = mock.posted().length;

  // Send exact same message — should be deduped
  mock.send({ ...event, envelope_id: "env-2b" });
  await new Promise(r => setTimeout(r, 500));
  assert.equal(mock.posted().length, countAfterFirst, "duplicate should be ignored");
});
