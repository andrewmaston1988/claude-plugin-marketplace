// The Codex subscription-limit transcript, verbatim from a real run: the message
// arrives once as an `error` event and again inside `turn.failed`, with a curly
// apostrophe. The thread id is fixed so nothing else in the line classifies it.
export const CODEX_QUOTA_MESSAGE = "You’ve hit your usage limit. Upgrade to Pro (https://chatgpt.com/explore/pro), visit https://chatgpt.com/settings/usage to purchase more credits or try again at 9:58 PM.";

export const CODEX_QUOTA_JSONL = [
  JSON.stringify({ type: "thread.started", thread_id: "01a20000-8978-72f1-98a1-84edb751af3a" }),
  JSON.stringify({ type: "turn.started" }),
  JSON.stringify({ type: "error", message: CODEX_QUOTA_MESSAGE }),
  JSON.stringify({ type: "turn.failed", error: { message: CODEX_QUOTA_MESSAGE } }),
].join("\n") + "\n";
