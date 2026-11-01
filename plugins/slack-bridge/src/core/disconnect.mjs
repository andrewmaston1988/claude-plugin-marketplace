// A claim whose live session has gone. Red means gone and only gone: the broker
// reports the peer absent, which is process death, and nothing else.
import { closePeerWindows } from "./live-route.mjs";

const DISCONNECTED_COLOR = "#d00000";

/**
 * The operator's own words: a red block reading SESSION DISCONNECTED, with the
 * session GUID, so a dead session is never mistaken for a slow one.
 */
export function disconnectText(sessionId) {
  const guid = sessionId ? `\`${sessionId}\`` : "unknown";
  return `⚠️ SESSION DISCONNECTED — Claude session ${guid} is disconnected`;
}

export async function postDisconnectNotice({ channel, sessionId = null, web, log }) {
  try {
    await web.chatPostMessage({
      channel,
      text: "",
      attachments: [{ color: DISCONNECTED_COLOR, text: disconnectText(sessionId), mrkdwn_in: ["text"] }],
    });
    return true;
  } catch (e) {
    log?.warn?.("failed to post disconnect notice", { channel, error: e.message });
    return false;
  }
}

/**
 * Post the red block, close the peer's windows and release the claim.
 *
 * The claim is re-read and released BEFORE the first await: the daemon's sweep
 * and the handler's dead-peer branch race on the same claim, and both posting
 * would leave two blocks. A channel re-seized meanwhile no longer names this
 * peer, so its new session is never marked dead.
 *
 * Returns true when this call is the one that acted.
 */
export async function markDisconnected({ claim, web, claims, log }) {
  const channel = claim?.channel;
  const peerId = claim?.peer_id;
  if (!channel || !peerId) return false;

  const current = claims.get(channel);
  if (!current || current.peer_id !== peerId) return false;
  claims.release(peerId);

  const sessionId = claim.session_id ?? claims.history?.(channel)?.session_id ?? null;
  await postDisconnectNotice({ channel, sessionId, web, log });

  // Not finalizeWindow: that writes "your message stays queued" into a channel
  // nobody is going to answer in.
  await closePeerWindows(peerId);
  log?.info?.("remote claim disconnected", { channel, peer_id: peerId, session_id: sessionId });
  return true;
}

/**
 * One tick of liveness for every claim. `listPeers` is read once — a failure is
 * no reading at all, so the tick is skipped rather than disconnecting everyone.
 * Returns the peer-ids dropped.
 */
export async function sweepClaims({ broker, claims, web, log }) {
  let peers;
  try {
    peers = await broker.listPeers();
  } catch (e) {
    log?.warn?.("disconnect sweep skipped: broker unreachable", { error: e.message });
    return [];
  }
  if (!Array.isArray(peers)) return [];

  const alive = new Set(peers.map((p) => p?.id).filter(Boolean));
  const dropped = [];
  for (const claim of Object.values(claims.all())) {
    if (alive.has(claim.peer_id)) continue;
    if (await markDisconnected({ claim, web, claims, log })) dropped.push(claim.peer_id);
  }
  return dropped;
}

/**
 * A channel that was once seized under an `rc-` name. The record outlives the
 * claim, so the channel keeps the no-spawn rule after release — a name alone
 * would let a hand-made `#rc-` channel through.
 */
export function isRemoteChannel(claims, channel) {
  const record = claims.history?.(channel);
  return typeof record?.channel_name === "string" && record.channel_name.startsWith("rc-");
}
