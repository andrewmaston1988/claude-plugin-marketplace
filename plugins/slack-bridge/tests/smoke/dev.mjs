#!/usr/bin/env node
/**
 * Scripted smoke test against a real dev Slack app.
 *
 * Required env vars:
 *   SMOKE_BOT_TOKEN   — xoxb-... bot token
 *   SMOKE_APP_TOKEN   — xapp-... app-level token
 *   SMOKE_CHANNEL     — channel ID to post to (e.g. C01234567)
 *
 * Exits 0 on pass, 1 on failure.
 */
import { createWebClient } from "../../src/web-api/index.mjs";

const BOT_TOKEN = process.env.SMOKE_BOT_TOKEN;
const CHANNEL   = process.env.SMOKE_CHANNEL;

if (!BOT_TOKEN || !CHANNEL) {
  console.error("SMOKE_BOT_TOKEN and SMOKE_CHANNEL are required.");
  process.exit(1);
}

const noop = { info() {}, warn() {}, error() {}, child() { return noop; } };
const web = createWebClient({ token: BOT_TOKEN, log: noop });

console.log("Smoke: auth.test...");
const auth = await web.authTest();
console.log(`  Authenticated as ${auth.user} in ${auth.team}`);

console.log(`Smoke: posting to ${CHANNEL}...`);
const posted = await web.chatPostMessage({
  channel: CHANNEL,
  text: "",
  attachments: [{ color: "#36a64f", text: "_smoke test: bridge post OK_", mrkdwn_in: ["text"] }],
});
console.log(`  Posted ts=${posted.ts}`);

console.log("Smoke: updating message...");
await web.chatUpdate({
  channel: CHANNEL,
  ts: posted.ts,
  text: "",
  attachments: [{ color: "#36a64f", text: "_smoke test: update OK_", mrkdwn_in: ["text"] }],
});
console.log("  Updated OK");

console.log("Smoke: deleting message...");
await web.chatDelete({ channel: CHANNEL, ts: posted.ts });
console.log("  Deleted OK");

console.log("\nAll smoke checks passed.");
setImmediate(() => process.exit(0));
