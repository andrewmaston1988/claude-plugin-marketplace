// A prompt typed at a claimed session's terminal, posted to its channel as the
// operator. Returns whether it posted: a prompt that never posts is retried on every
// lease.
import { mdToSlack } from "../markdown/index.mjs";

export async function postTerminalPrompt({ web, channel, text, config, log }) {
  const converted = mdToSlack(text);
  const name = config.remote?.operatorName ?? null;
  const icon = config.remote?.operatorIconUrl ?? null;
  // Only the name signs a post; an icon cannot. Without one, mark the text as
  // typed elsewhere so it never reads as the bot talking to itself.
  const plain = `⌨️ ${converted}`;
  const postParams = { channel, text: name ? converted : plain };
  if (name) postParams.username = name;
  if (icon) postParams.icon_url = icon;
  try {
    await web.chatPostMessage(postParams);
    return true;
  } catch (e) {
    // Only Slack's own refusal is retried: after a timeout the first post may have
    // landed, and a second would show the prompt twice.
    if ((!name && !icon) || !e.slackError) {
      log.warn("failed to post terminal prompt", { channel, error: e.message });
      return false;
    }
    // Slack rejects a custom identity without chat:write.customize, so fall back once.
    log.warn("terminal prompt rejected with the custom identity — retrying plain", { channel, error: e.message });
  }
  try {
    await web.chatPostMessage({ channel, text: plain });
    return true;
  } catch (e) {
    log.warn("failed to post terminal prompt", { channel, error: e.message });
    return false;
  }
}
