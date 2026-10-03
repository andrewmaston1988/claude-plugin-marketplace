import { isClaudeModel } from "./claude-subprocess.mjs";

// Store values were bare session-id strings before /model; a legacy string has no model.
export function readSession(store, key) {
  const v = store.get(key);
  if (typeof v === "string") return { sessionId: v };
  return v && typeof v === "object" ? v : {};
}

export function channelModel(store, channel) {
  return readSession(store, channel).model ?? null;
}

export function writeSession(store, key, patch) {
  store.set(key, { ...readSession(store, key), ...patch });
}

export function clearSession(store, key) {
  const { sessionId, ...rest } = readSession(store, key);
  if (Object.keys(rest).length) store.set(key, rest);
  else store.delete(key);
}

// A session started on `claude` cannot resume through the proxy, or the reverse, so a
// switch across that line drops the channel's session and its threads' sessions.
export function setChannelModel(store, channel, model) {
  const prev = channelModel(store, channel);
  if (prev && isClaudeModel(prev) !== isClaudeModel(model)) {
    for (const key of Object.keys(store.all())) {
      if (key.startsWith(`${channel}:`)) clearSession(store, key);
    }
    clearSession(store, channel);
  }
  writeSession(store, channel, { model });
}
