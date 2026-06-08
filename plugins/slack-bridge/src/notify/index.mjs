import { mdToSlack, mdToBlocks, hasTable, splitResponse } from "../markdown/index.mjs";

// Notify Slack with paragraph-aware chunking for long messages.
//
// Slack's `attachment.text` field clips silently around 8000 chars. For long
// notifications (e.g. governance reports), we use the same paragraph-splitter
// the bot conversation handler uses (see core/handler.mjs:191-205): split at
// blank lines into ≤3000-char chunks and post each as its own message in the
// channel. Title goes on the first chunk; subsequent chunks have no title.
// Tables still take the blocks path which can handle long content natively.
export async function notify({ web, channel, title, message, log }) {
  if (!channel) return;
  let raw      = message ?? "";
  // Publisher extracts envelope.title from the body's first `# Heading` line
  // (see publisher.mjs:147). When the body still leads with that same H1, the
  // notify layer would render `*Title*\n*Title*\n…` — a visible header
  // duplicate. Strip the leading H1 here when it matches the title, before
  // mdToSlack conversion, so reports stay clean on Slack without altering the
  // on-disk file.
  if (title) {
    const re = new RegExp(`^#\\s+${title.replace(/[.*+?^${}()|[\\]\\\\]/g, "\\$&")}\\s*\\n+`);
    raw = raw.replace(re, "");
  }
  const mrkdwn = mdToSlack(raw);
  const blocks = hasTable(raw) ? mdToBlocks(raw) : null;
  try {
    let resp;
    if (blocks) {
      resp = await web.chatPostMessage({ channel, text: title, blocks });
    } else {
      // Use plain `text:` rather than `attachments[].text` so Slack renders
      // full-width without the gray sidebar/indent (matches the old
      // notify.ps1 shape: title bolded inline, body underneath, full-width).
      // First chunk carries the title so search + previews still hit it;
      // subsequent chunks are body-only.
      const chunks = splitResponse(mrkdwn);
      for (let i = 0; i < chunks.length; i++) {
        const text = i === 0 ? `*${title}*\n${chunks[i]}` : chunks[i];
        resp = await web.chatPostMessage({ channel, text });
      }
    }
    log?.info("notify ok", { channel, ts: resp?.ts });
  } catch (e) {
    log?.warn("notify failed", { channel, error: e.message });
  }
}
