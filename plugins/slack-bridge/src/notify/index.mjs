import { mdToSlack, mdToBlocks, hasTable } from "../markdown/index.mjs";

export async function notify({ web, channel, title, message, log }) {
  if (!channel) return;
  const mrkdwn = mdToSlack(message ?? "");
  const blocks = hasTable(message ?? "") ? mdToBlocks(message ?? "") : null;
  try {
    if (blocks) {
      await web.chatPostMessage({ channel, text: title, blocks });
    } else {
      await web.chatPostMessage({
        channel,
        text: title,
        attachments: [{ text: mrkdwn, mrkdwn_in: ["text"] }],
      });
    }
  } catch (e) {
    log?.warn("notify failed", { channel, error: e.message });
  }
}
