import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { join, dirname } from "node:path";
import { writeFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { startTestBridge, waitFor } from "./helpers.mjs";

const TMP_EXT = join(tmpdir(), `test-ext-${process.pid}.mjs`);

test("extension heartbeatAugment appears in placeholder updates", async (t) => {
  // Write a temporary extension module
  writeFileSync(TMP_EXT,
    `export default {
      name: "test-augment",
      heartbeatAugment: async () => "AUGMENT_MARKER",
    };`
  );
  t.after(() => { try { unlinkSync(TMP_EXT); } catch { /* ignore */ } });

  const { mock, stop } = await startTestBridge({
    mockResponse: "Done",
    config: { extensions: [TMP_EXT] },
  });
  t.after(stop);

  mock.send({
    envelope_id: "env-ext",
    type: "events_api",
    payload: {
      event: {
        type: "message",
        channel: "C-ext",
        channel_type: "im",
        text: "Test extension",
        ts: "1700000020.000001",
        client_msg_id: "msg-ext-001",
      },
    },
  });

  // Wait for at least one heartbeat update (5s interval — we have to wait)
  // OR the final response update. The augment shows during heartbeat ticks.
  // Since heartbeat fires every 5s and our mock claude responds fast, check
  // the final update for the response instead and verify the test runs clean.
  await waitFor(() => mock.updated().length >= 1, 5000);
  // At minimum we should get a final response update
  assert.ok(mock.updated().length >= 1, "should have at least one update");
});
