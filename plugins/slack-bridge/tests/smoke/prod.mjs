#!/usr/bin/env node
/**
 * Scripted smoke test against the production Slack workspace.
 * Same shape as dev.mjs; different channel/tokens via env.
 *
 * Required env vars:
 *   SMOKE_PROD_BOT_TOKEN  — xoxb-... bot token
 *   SMOKE_PROD_CHANNEL    — channel ID
 *
 * Exits 0 on pass, 1 on failure.
 */
import { createWebClient } from "../../src/web-api/index.mjs";

const BOT_TOKEN = process.env.SMOKE_PROD_BOT_TOKEN ?? process.env.SMOKE_BOT_TOKEN;
const CHANNEL   = process.env.SMOKE_PROD_CHANNEL   ?? process.env.SMOKE_CHANNEL;

if (!BOT_TOKEN || !CHANNEL) {
  console.error("SMOKE_PROD_BOT_TOKEN and SMOKE_PROD_CHANNEL are required (or SMOKE_BOT_TOKEN / SMOKE_CHANNEL).");
  process.exit(1);
}

const noop = { info() {}, warn() {}, error() {}, child() { return noop; } };
const web = createWebClient({ token: BOT_TOKEN, log: noop });

console.log("Smoke [prod]: auth.test...");
const auth = await web.authTest();
console.log(`  Authenticated as ${auth.user} in ${auth.team}`);

console.log(`Smoke [prod]: posting to ${CHANNEL}...`);
const posted = await web.chatPostMessage({
  channel: CHANNEL,
  text: "",
  attachments: [{ color: "#36a64f", text: "_smoke test: bridge post OK_", mrkdwn_in: ["text"] }],
});
console.log(`  Posted ts=${posted.ts}`);

console.log("Smoke [prod]: updating message...");
await web.chatUpdate({
  channel: CHANNEL,
  ts: posted.ts,
  text: "",
  attachments: [{ color: "#36a64f", text: "_smoke test: update OK_", mrkdwn_in: ["text"] }],
});

console.log("Smoke [prod]: deleting message...");
await web.chatDelete({ channel: CHANNEL, ts: posted.ts });

console.log("\nAll prod smoke checks passed.");
setImmediate(() => process.exit(0));
