// Control endpoint — the token-guarded localhost HTTP surface the live session's
// remote-mcp server calls. Routes: /claim, /release, /health.
import http from "node:http";

const MAX_BODY_BYTES = 1_000_000;

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
  // `name` labels the created channel: #rc-<slug> (e.g. #rc-long-night). The rc-
  // prefix namespaces remote-control channels apart from real project channels.
  // Falls back to the peer-id fragment when no usable name is provided.
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
      if (!channelId) throw new Error("channel creation failed after retries — provide a channel or try again");
      const channelName = created?.channel?.name ?? chanName;
      let topic = null;
      if (channelId) {
        try {
          await web.conversationsSetTopic({ channel: channelId, topic: `live session ${peerId}` });
          topic = `live session ${peerId}`;
        } catch (e) { log("setTopic failed (needs channels:manage scope)", { error: e.message }); }
      }
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
      // rejected claim (held channel, second channel) never orphans one.
      const pre = claims.canClaim(body.peer_id, body.channel ?? null);
      if (!pre.ok) return pre;
      const { id, name, topic, is_dm } = await claimChannel(body.peer_id, body.channel, body.name);
      const r = claims.claim(body.peer_id, id, { channelName: name });
      if (!r.ok) return r;
      return { ok: true, channel: id, channel_name: name, topic, is_dm: !!is_dm };
    },
    "/release": async (body) => {
      if (!body.peer_id) return { ok: false, error: "peer_id required" };
      claims.release(body.peer_id);
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
