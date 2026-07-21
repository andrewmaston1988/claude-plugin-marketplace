// Control endpoint: the localhost HTTP surface the live session's MCP server
// calls to seize/release a Slack channel and post outbound messages. Token-guarded
// (shared secret in bridge config, passed to the MCP server). Default localhost-only.
//
// /claim    {peer_id, channel?, name?} — create #rc-<name-slug> (if scopes allow) or
//                                       join the given channel; records the claim.
//                                       `name` defaults the channel to the session's
//                                       context (cwd basename / operator label).
//                                       Returns {channel, ...}.
// /release  {peer_id}            — frees the peer's claim.
// /post     {peer_id, message}   — posts to the peer's claimed channel.
// /heartbeat{peer_id}           — refreshes last_seen.
// /health                          — liveness.
import http from "node:http";

const MAX_BODY_BYTES = 1_000_000;

function shortName(peerId) {
  return String(peerId).slice(0, 4).toLowerCase();
}

// Slack channel names: lowercase, [a-z0-9_-], max 80 chars. Slugify a context
// label (the session's cwd basename or an operator-supplied label) into a channel
// suffix. Returns null for an empty/all-invalid input so the caller can fall back
// to the peer-id fragment.
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
  log = () => {},
} = {}) {
  // `name` is an optional descriptive label for the created channel (the session's
  // cwd basename or an operator-supplied label). When present + slugifiable, the
  // channel is `#rc-<slug>` (e.g. `#rc-long-night`) — the /rc-style "a channel with a
  // name describing the chat context just appears" experience. The `rc-` prefix
  // namespaces remote-control channels so they group together and don't collide with
  // real project channels, and generalizes across every project. Falls back to the
  // peer-id fragment when no usable name is provided.
  async function claimChannel(peerId, channel, name) {
    if (channel) {
      const joined = await web.conversationsJoin({ channel });
      const ch = joined?.channel ?? { id: channel };
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
          if (e?.slackError === "name_taken" || /name_taken/i.test(e?.message ?? "")) {
            chanName = `${base}-${attempt + 2}`;
            continue;
          }
          throw e;
        }
      }
      const channelId = created?.channel?.id;
      const channelName = created?.channel?.name ?? chanName;
      let topic = null;
      if (channelId) {
        try {
          await web.conversationsSetTopic({ channel: channelId, topic: `live session ${peerId}` });
          topic = `live session ${peerId}`;
        } catch (e) { log("setTopic failed (needs channels:manage scope)", { error: e.message }); }
      }
      return { id: channelId, name: channelName, topic };
    }
    // DM-seize fallback (no channel-creation scopes): join an existing IM with the bot.
    // The operator's DM is the natural remote-control surface when scopes are absent.
    if (web.conversationsList) {
      const list = await web.conversationsList({ types: "im", limit: 10 });
      const im = list?.channels?.[0];
      if (im) return { id: im.id, name: im.name ?? null, topic: null };
    }
    throw new Error("no channel specified and channel-creation scopes not configured — provide a channel or add channels:write/channels:manage");
  }

  const handlers = {
    "/claim": async (body) => {
      if (!body.peer_id) return { ok: false, error: "peer_id required" };
      const { id, name, topic } = await claimChannel(body.peer_id, body.channel, body.name);
      const r = claims.claim(body.peer_id, id, { channelName: name });
      if (!r.ok) return r;
      return { ok: true, channel: id, channel_name: name, topic };
    },
    "/release": async (body) => {
      if (!body.peer_id) return { ok: false, error: "peer_id required" };
      claims.release(body.peer_id);
      return { ok: true };
    },
    "/post": async (body) => {
      if (!body.peer_id) return { ok: false, error: "peer_id required" };
      const claim = claims.getByPeer(body.peer_id);
      if (!claim) return { ok: false, error: `no claim for peer ${body.peer_id}` };
      await web.chatPostMessage({ channel: claim.channel, text: String(body.message ?? "") });
      return { ok: true };
    },
    "/heartbeat": async (body) => {
      if (!body.peer_id) return { ok: false, error: "peer_id required" };
      claims.touch?.(body.peer_id);
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