// Control endpoint: the localhost HTTP surface the live session's MCP server
// calls to seize/release a Slack channel and post outbound messages. Token-guarded
// (shared secret in bridge config, passed to the MCP server). Default localhost-only.
//
// /claim    {peer_id, channel?}  — create #ln-<short> (if scopes allow) or join the
//                                 given channel; records the claim. Returns {channel, ...}.
// /release  {peer_id}            — frees the peer's claim.
// /post     {peer_id, message}   — posts to the peer's claimed channel.
// /heartbeat{peer_id}           — refreshes last_seen.
// /health                          — liveness.
import http from "node:http";

const MAX_BODY_BYTES = 1_000_000;

function shortName(peerId) {
  return String(peerId).slice(0, 4).toLowerCase();
}

export function createControlServer({
  web,
  claims,
  token,
  canCreateChannels = false,
  log = () => {},
} = {}) {
  async function claimChannel(peerId, channel) {
    if (channel) {
      const joined = await web.conversationsJoin({ channel });
      const ch = joined?.channel ?? { id: channel };
      return { id: ch.id ?? channel, name: ch.name ?? null, topic: null };
    }
    if (canCreateChannels) {
      const base = `ln-${shortName(peerId)}`;
      let name = base;
      let created;
      for (let attempt = 0; attempt < 4; attempt++) {
        try {
          created = await web.conversationsCreate({ name });
          break;
        } catch (e) {
          if (e?.slackError === "name_taken" || /name_taken/i.test(e?.message ?? "")) {
            name = `${base}-${attempt + 2}`;
            continue;
          }
          throw e;
        }
      }
      const channelId = created?.channel?.id;
      const channelName = created?.channel?.name ?? name;
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
      const { id, name, topic } = await claimChannel(body.peer_id, body.channel);
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