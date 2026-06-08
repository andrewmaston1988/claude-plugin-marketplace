/**
 * Fetch recent channel history and format as a context prelude for Claude.
 * Returns "" if limit is falsy, if the API call fails, or if there is no text content.
 */
export async function fetchHistory({ web, channel, limit, log }) {
  if (!limit) return "";

  let messages;
  try {
    const resp = await web.conversationsHistory({ channel, limit });
    messages = (resp.messages ?? []).slice().reverse(); // oldest first
  } catch (e) {
    log.warn("conversations_history failed", { channel, error: e.message });
    return "";
  }

  if (!messages.length) return "";

  const SKIP_SUBTYPES = new Set(["channel_join", "channel_leave", "channel_purpose", "channel_topic"]);
  const lines = [];

  for (const msg of messages) {
    if (SKIP_SUBTYPES.has(msg.subtype)) continue;
    const user = msg.username ?? msg.user ?? msg.bot_id ?? "unknown";
    const text = (msg.text ?? "").trim();
    if (text) lines.push(`[${user}]: ${text}`);

    if ((msg.reply_count ?? 0) > 0) {
      try {
        const tresp = await web.conversationsReplies({ channel, ts: msg.ts });
        const replies = (tresp.messages ?? []).slice(1); // skip parent
        for (const reply of replies) {
          const ru = reply.username ?? reply.user ?? reply.bot_id ?? "unknown";
          const rt = (reply.text ?? "").trim();
          if (rt) lines.push(`  [thread · ${ru}]: ${rt}`);
        }
      } catch (e) {
        log.info("conversations_replies failed", { ts: msg.ts, error: e.message });
      }
    }
  }

  if (!lines.length) return "";

  return (
    `<channel_history>\n` +
    `The following is the recent history of this Slack channel ` +
    `(oldest first, up to ${limit} messages). ` +
    `Use it as background context for the conversation.\n\n` +
    lines.join("\n") +
    `\n</channel_history>\n\n`
  );
}
