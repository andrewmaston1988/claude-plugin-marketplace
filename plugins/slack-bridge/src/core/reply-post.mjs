import { mdToSlack, mdToBlocks, hasTable } from "../markdown/index.mjs";

function splitResponse(text, maxLen = 3000) {
  if (text.length <= maxLen) return [text];
  const chunks = [];
  const paras = text.split(/\n\n+/);
  let current = "";
  for (const para of paras) {
    if (current.length + para.length + 2 > maxLen) {
      if (current) chunks.push(current.trim());
      current = para.length > maxLen ? para.slice(0, maxLen) : para;
    } else {
      current = current ? current + "\n\n" + para : para;
    }
  }
  if (current.trim()) chunks.push(current.trim());
  return chunks.length ? chunks : [text.slice(0, maxLen)];
}

/**
 * Update a placeholder message; if Slack reports it no longer exists,
 * fall back to posting a new message in the same thread.
 */
export async function safeUpdate({ web, channel, ts, params, threadTs }) {
  try {
    await web.chatUpdate({ channel, ts, ...params });
  } catch (e) {
    if (e.slackError === "message_not_found" || e.slackError === "cant_update_message") {
      const postParams = { channel, ...params };
      if (threadTs) postParams.thread_ts = threadTs;
      await web.chatPostMessage(postParams);
    } else {
      throw e;
    }
  }
}

/**
 * Post claude's reply — mirrors the historic .py recipe: the reply is the clean
 * message body (chat_update text=response_text), NOT wrapped in a Slack attachment.
 * The mjs port had put the whole reply inside attachments[].text, so it rendered
 * inside the "|" attachment bar. Tables use Block Kit blocks; long replies split
 * into multiple plain-text posts. The first-in-session title uses **bold** (md)
 * so mdToSlack converts it to *bold* (mrkdwn), matching the .py.
 */
export async function postResponse({ web, channel, placeholderTs, threadTs, responseText, existingSession, isFirstInSession, cmdEcho, extensions, sessionId, config }) {
  const title = (!existingSession && isFirstInSession) ? `**${cmdEcho}**\n\n` : null;
  const fullText = title ? title + (responseText ?? "") : (responseText ?? "");

  // End-of-turn progress attachment — historic .py parity (slack_bridge.py:711-714
  // posted _progress_snippet() as a coloured attachment on the reply). Sourced from
  // the pipeline progress-steps DB via the extension's responseAugment hook; null
  // when there's no active progress or no extension. Never let it fail the reply.
  let progressAttachment = null;
  if (extensions) {
    try {
      const snippet = await extensions.runResponseAugment({ channel, sessionId, isFirstInSession, config });
      if (snippet) progressAttachment = { color: "#808080", text: snippet, mrkdwn_in: ["text"] };
    } catch { /* progress is a sidebar; never fail the response on it */ }
  }

  if (hasTable(fullText)) {
    const blocks = mdToBlocks(fullText);
    if (blocks) {
      await web.chatDelete({ channel, ts: placeholderTs });
      const postParams = { channel, text: cmdEcho, blocks };
      if (threadTs) postParams.thread_ts = threadTs;
      await web.chatPostMessage(postParams);
      if (progressAttachment) await postProgressAttachment({ web, channel, threadTs, attachment: progressAttachment });
      return;
    }
  }

  const mrkdwn = mdToSlack(fullText);
  const chunks = splitResponse(mrkdwn);

  if (chunks.length === 1) {
    // Reply as the message body — no attachment wraps it (the .py recipe).
    // attachments must be sent explicitly: omitted, Slack keeps the heartbeat's echo.
    const params = { text: mrkdwn, attachments: progressAttachment ? [progressAttachment] : [] };
    await safeUpdate({ web, channel, ts: placeholderTs, threadTs, params });
  } else {
    await web.chatDelete({ channel, ts: placeholderTs });
    for (let i = 0; i < chunks.length; i++) {
      const postParams = { channel, text: chunks[i] };
      if (threadTs) postParams.thread_ts = threadTs;
      // Attach the progress snippet to the final chunk so it appears once, at the end.
      if (progressAttachment && i === chunks.length - 1) postParams.attachments = [progressAttachment];
      await web.chatPostMessage(postParams);
    }
  }
}

/**
 * Post the end-of-turn progress snippet as a standalone coloured attachment —
 * used when the reply itself is Block Kit blocks (blocks + attachments don't
 * combine cleanly on one message). Swallows Slack errors; progress is a sidebar.
 */
async function postProgressAttachment({ web, channel, threadTs, attachment }) {
  const postParams = { channel, text: "", attachments: [attachment] };
  if (threadTs) postParams.thread_ts = threadTs;
  try { await web.chatPostMessage(postParams); } catch { /* sidebar; ignore */ }
}

/**
 * Post an error as plain message text — .py recipe: text="_Error: …_", attachments=[].
 * The mjs port had wrapped it in a red attachment; restore plain text so the error
 * isn't inside the "|" bar. Swallows Slack errors (placeholder may already be gone).
 */
export async function postError({ web, channel, placeholderTs, threadTs, message }) {
  try {
    await safeUpdate({ web, channel, ts: placeholderTs, threadTs, params: { text: `_Error: ${message}_`, attachments: [] } });
  } catch { /* placeholder already gone; error was already logged by the caller */ }
}
