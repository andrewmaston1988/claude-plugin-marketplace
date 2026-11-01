// Control endpoint — the token-guarded localhost HTTP surface the live session's
// remote-mcp server calls. Routes: /claim, /release, /health.
import http from "node:http";

const MAX_BODY_BYTES = 1_000_000;

// Every state change is an attachment, so the channel history reads back as a
// timeline of what held it and when.
const SEIZED_COLOR = "#2eb67d";
const RELEASED_COLOR = "#ecb22e";
const seizedText = (sessionId) => `▶️ Claude session \`${sessionId}\` seized this channel`;
const releasedText = (sessionId) => `⏸️ Claude session \`${sessionId}\` released this channel`;

function shortName(peerId) {
  return String(peerId).slice(0, 4).toLowerCase();
}

// Slack channel names: lowercase [a-z0-9_-], max 80 chars. Returns null for an
// empty/all-invalid input so the caller falls back to the peer-id fragment.
function slugify(s) {
  if (!s) return null;
  return String(s).toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40) || null;
}

export function createControlServer({
  web,
  claims,
  token,
  canCreateChannels = false,
  operatorUserId = null,
  log = () => {},
} = {}) {
  // Without the channels:join scope a channel the bot was invited into is still
  // seizable; one it is not in needs the operator to invite it.
  async function joinChannel(channel) {
    try {
      return (await web.conversationsJoin({ channel }))?.channel ?? { id: channel };
    } catch (e) {
      if (e?.slackError !== "missing_scope") throw e;
      // The membership check itself needs channels:read; without it, say what to do.
      const ch = await web.conversationsInfo({ channel }).then((r) => r?.channel, () => null);
      if (ch?.is_member) return ch;
      throw new Error(`the bot is not in channel ${channel} and lacks the channels:join scope — invite the bot to the channel first (/invite @<bot>), or add channels:join to the app's bot scopes`);
    }
  }

  // A failure here is logged and swallowed: the claim it describes is already
  // made, and a channel that cannot take a message must not fail the seize.
  async function postLine({ channel, color, text, what }) {
    try {
      await web.chatPostMessage({ channel, text: "", attachments: [{ color, text, mrkdwn_in: ["text"] }] });
    } catch (e) {
      log(`failed to post the ${what} line`, { channel, error: e.message });
    }
  }

  // Topic and invite, shared by a created channel and a reused one.
  async function describeChannel(id, peerId) {
    let topic = null;
    try {
      topic = `live session ${peerId}`;
      await web.conversationsSetTopic({ channel: id, topic });
    } catch (e) { topic = null; log("setTopic failed (needs channels:manage scope)", { error: e.message }); }
    if (operatorUserId) {
      try {
        await web.conversationsInvite({ channel: id, users: operatorUserId });
      } catch (e) {
        if (e?.slackError !== "already_in_channel") {
          log("operator invite failed", { error: e.message, channel: id, user: operatorUserId });
        }
      }
    } else {
      log("operator invite skipped: no remote.operatorUserId", { channel: id });
    }
    return topic;
  }

  // A re-seize must not fork a second #rc-demo: on name_taken, find the channel
  // of exactly that name. users.conversations lists the bot's own channels, so
  // membership is implied; canClaim is the real test — a channel another peer
  // holds is never taken over. Public only: conversations.create makes public
  // channels, and the manifest holds channels:read but no groups:read.
  async function findReusableChannel(peerId, name) {
    if (typeof web.usersConversations !== "function") return null;
    let cursor = null;
    do {
      const page = await web.usersConversations({
        types: "public_channel", limit: 200, ...(cursor ? { cursor } : {}),
      });
      for (const ch of page?.channels ?? []) {
        if (ch?.name === name && ch.id && claims.canClaim(peerId, ch.id).ok) return ch;
      }
      cursor = page?.response_metadata?.next_cursor || null;
    } while (cursor);
    return null;
  }

  // `name` labels the created channel: #rc-<slug> (e.g. #rc-long-night). The rc-
  // prefix namespaces remote-control channels apart from real project channels.
  // Falls back to the peer-id fragment when no usable name is provided.
  async function claimChannel(peerId, channel, name) {
    if (channel) {
      const ch = await joinChannel(channel);
      return { id: ch.id ?? channel, name: ch.name ?? null, topic: null };
    }
    if (canCreateChannels) {
      const base = `rc-${slugify(name) || shortName(peerId)}`;
      let chanName = base;
      let created;
      for (let attempt = 0; attempt < 4; attempt++) {
        try {
          created = await web.conversationsCreate({ name: chanName });
          break;
        } catch (e) {
          if (e?.slackError !== "name_taken" && !/name_taken/i.test(e?.message ?? "")) throw e;
          let existing = null;
          try {
            existing = await findReusableChannel(peerId, chanName);
          } catch (err) {
            log("channel lookup failed — falling through to a new suffix", { error: err.message, name: chanName });
          }
          if (existing) { created = { channel: existing }; break; }
          chanName = `${base}-${attempt + 2}`;
        }
      }
      const channelId = created?.channel?.id;
      if (!channelId) throw new Error("channel creation failed after retries — provide a channel or try again");
      const channelName = created?.channel?.name ?? chanName;
      const topic = await describeChannel(channelId, peerId);
      return { id: channelId, name: channelName, topic, is_dm: false };
    }
    // DM-seize fallback (no channel-creation scopes): the operator's own DM
    // with the bot, matched on remote.operatorUserId. Never the first IM in
    // the list — that could be anyone's DM.
    if (web.conversationsList) {
      if (!operatorUserId) {
        throw new Error("no channel specified, no channel-creation scopes, and no remote.operatorUserId to select the DM — provide a channel or configure either");
      }
      const list = await web.conversationsList({ types: "im", limit: 100 });
      const im = list?.channels?.find((c) => c.user === operatorUserId);
      if (!im) {
        throw new Error(`no DM with the bot found for operator user ${operatorUserId} — message the bot once so the DM exists`);
      }
      return { id: im.id, name: im.name ?? null, topic: null, is_dm: true };
    }
    throw new Error("no channel specified and channel-creation scopes not configured — provide a channel or add channels:write/channels:manage");
  }

  const handlers = {
    "/claim": async (body) => {
      if (!body.peer_id) return { ok: false, error: "peer_id required" };
      // Pre-check the claim store BEFORE creating any Slack channel, so a
      // rejected claim (held channel, second channel) normally never orphans
      // one. Not airtight: claims.claim re-checks, but a concurrent /claim
      // that passed this same pre-check while claimChannel awaited Slack can
      // lose the store race and orphan its channel.
      const pre = claims.canClaim(body.peer_id, body.channel ?? null);
      if (!pre.ok) return pre;
      const { id, name, topic, is_dm } = await claimChannel(body.peer_id, body.channel, body.name);
      const sessionId = body.session_id ?? null;
      // Before the claim: the record outlives it, and an #rc-* channel that lost
      // its record would start spawning after release.
      claims.recordHistory(id, { session_id: sessionId, channel_name: name });
      const r = claims.claim(body.peer_id, id, { channelName: name, sessionId });
      if (!r.ok) return r;
      if (sessionId) await postLine({ channel: id, color: SEIZED_COLOR, text: seizedText(sessionId), what: "seize" });
      return { ok: true, channel: id, channel_name: name, topic, is_dm: !!is_dm };
    },
    "/release": async (body) => {
      if (!body.peer_id) return { ok: false, error: "peer_id required" };
      const held = Object.entries(claims.all()).find(([, c]) => c?.peer_id === body.peer_id);
      claims.release(body.peer_id);
      if (held) {
        const [channel, claim] = held;
        const sessionId = claim.session_id ?? claims.history?.(channel)?.session_id ?? null;
        if (sessionId) await postLine({ channel, color: RELEASED_COLOR, text: releasedText(sessionId), what: "release" });
      }
      return { ok: true };
    },
  };

  const server = http.createServer((req, res) => {
    const json = (status, value) => {
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(value));
    };

    // Token guard: every request must carry the shared secret. Secure-by-default —
    // a missing token rejects everything (the doctor flags an unconfigured endpoint).
    const auth = req.headers.authorization ?? "";
    const provided = auth.startsWith("Bearer ") ? auth.slice(7) : "";
    if (!token || provided !== token) return json(401, { error: "unauthorized" });

    if (req.method === "GET" && req.url === "/health") return json(200, { status: "ok" });
    if (req.method !== "POST") return json(404, { error: "not found" });

    let buf = "";
    let overflow = false;
    req.on("data", (c) => {
      if (overflow) return;
      buf += c;
      if (buf.length > MAX_BODY_BYTES) { overflow = true; json(413, { error: "body too large" }); req.destroy(); }
    });
    req.on("end", async () => {
      if (overflow) return;
      try {
        const handler = handlers[req.url];
        if (!handler) return json(404, { error: "not found" });
        const result = await handler(buf ? JSON.parse(buf) : {});
        json(200, result);
      } catch (e) {
        log("control handler error", { path: req.url, error: e.message });
        json(500, { ok: false, error: e.message });
      }
    });
  });

  return {
    listen: (port = 0) => new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(port, "127.0.0.1", () => resolve(server.address().port));
    }),
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}
