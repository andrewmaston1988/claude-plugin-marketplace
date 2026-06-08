/**
 * Minimal in-process mock Slack server.
 * Speaks Socket Mode WebSocket + a subset of the Web API over HTTP.
 * Zero dependencies — uses node:http and hand-rolled WebSocket framing.
 */
import { createServer } from "node:http";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";

// ─── WebSocket framing helpers ────────────────────────────────────────────────

function wsHandshake(req, socket) {
  const key = req.headers["sec-websocket-key"];
  const accept = createHash("sha1")
    .update(key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11")
    .digest("base64");
  socket.write(
    "HTTP/1.1 101 Switching Protocols\r\n" +
    "Upgrade: websocket\r\n" +
    "Connection: Upgrade\r\n" +
    `Sec-WebSocket-Accept: ${accept}\r\n\r\n`
  );
}

function wsEncode(data) {
  const payload = Buffer.from(JSON.stringify(data));
  const len = payload.length;
  const header = len < 126
    ? Buffer.from([0x81, len])
    : Buffer.from([0x81, 126, (len >> 8) & 0xff, len & 0xff]);
  return Buffer.concat([header, payload]);
}

function wsDecode(buf) {
  if (buf.length < 2) return null;
  const masked = (buf[1] & 0x80) !== 0;
  let len = buf[1] & 0x7f;
  let offset = 2;
  if (len === 126) { len = buf.readUInt16BE(2); offset = 4; }
  if (buf.length < offset + (masked ? 4 : 0) + len) return null;
  if (!masked) return JSON.parse(buf.slice(offset, offset + len).toString());
  const mask = buf.slice(offset, offset + 4);
  offset += 4;
  const decoded = Buffer.alloc(len);
  for (let i = 0; i < len; i++) decoded[i] = buf[offset + i] ^ mask[i % 4];
  return JSON.parse(decoded.toString());
}

// ─── Mock server ─────────────────────────────────────────────────────────────

/**
 * Start a mock Slack HTTP + WebSocket server.
 *
 * @param {{ scenario?: object }} opts
 * @returns {Promise<{
 *   url: string,
 *   wsUrl: string,
 *   send: (event: object) => void,
 *   posted: () => object[],
 *   stop: () => Promise<void>,
 *   events: EventEmitter,
 * }>}
 */
export async function startMockSlack({ scenario = {} } = {}) {
  const posted = [];       // chat.postMessage calls
  const updated = [];      // chat.update calls
  const deleted = [];      // chat.delete calls
  const apiCalls = {};     // method → call list

  let wsSocket = null;
  const emitter = new EventEmitter();

  const server = createServer((req, res) => {
    const method = req.url?.replace("/api/", "").replace(/\?.*$/, "") ?? "";
    let body = "";
    req.on("data", c => { body += c; });
    req.on("end", () => {
      let parsed = {};
      try {
        parsed = body.startsWith("{") ? JSON.parse(body) : Object.fromEntries(new URLSearchParams(body));
      } catch { /* ignore */ }

      apiCalls[method] = apiCalls[method] ?? [];
      apiCalls[method].push(parsed);
      emitter.emit("api-call", { method, body: parsed });

      const respond = (data) => {
        const json = JSON.stringify(data);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(json);
      };

      if (method === "auth.test") {
        return respond({ ok: true, user_id: "U123", user: "claude-bot", team: "TestTeam", team_id: "T123" });
      }
      if (method === "apps.connections.open") {
        return respond({ ok: true, url: `ws://localhost:${server.address().port}/ws` });
      }
      if (method === "chat.postMessage") {
        const ts = String(Date.now() / 1000);
        posted.push({ ...parsed, ts });
        emitter.emit("chat.postMessage", { ...parsed, ts });
        return respond({ ok: true, ts, channel: parsed.channel });
      }
      if (method === "chat.update") {
        updated.push(parsed);
        emitter.emit("chat.update", parsed);
        return respond({ ok: true, ts: parsed.ts, channel: parsed.channel });
      }
      if (method === "chat.delete") {
        deleted.push(parsed);
        return respond({ ok: true });
      }
      if (method === "conversations.history") {
        return respond({ ok: true, messages: scenario.history ?? [], has_more: false });
      }
      if (method === "conversations.replies") {
        return respond({ ok: true, messages: scenario.replies ?? [], has_more: false });
      }
      // Unknown method — return ok
      respond({ ok: true });
    });
  });

  // Handle WebSocket upgrade
  server.on("upgrade", (req, socket) => {
    wsSocket = socket;
    wsHandshake(req, socket);
    let buf = Buffer.alloc(0);
    socket.on("data", chunk => {
      buf = Buffer.concat([buf, chunk]);
      const msg = wsDecode(buf);
      if (msg) {
        buf = Buffer.alloc(0);
        emitter.emit("ws-message", msg);
        // Auto-ack disconnect
        if (msg.type === "goodbye" || msg.type === "disconnect") {
          socket.destroy();
        }
      }
    });
    socket.on("error", () => {});
    // Send hello
    socket.write(wsEncode({ type: "hello", num_connections: 1 }));
    emitter.emit("ws-connected");
  });

  await new Promise(r => server.listen(0, "127.0.0.1", r));
  const { port } = server.address();
  const url   = `http://127.0.0.1:${port}`;
  const wsUrl = `ws://127.0.0.1:${port}/ws`;

  return {
    url,
    wsUrl,

    /** Push a Socket Mode event to the connected client. */
    send(event) {
      if (!wsSocket || wsSocket.destroyed) throw new Error("no WS client connected");
      wsSocket.write(wsEncode(event));
    },

    /** All chat.postMessage bodies received so far. */
    posted() { return posted; },

    /** All chat.update bodies received so far. */
    updated() { return updated; },

    /** All chat.delete bodies received so far. */
    deleted() { return deleted; },

    /** Raw per-method call logs. */
    calls(method) { return apiCalls[method] ?? []; },

    /** EventEmitter: "api-call", "chat.postMessage", "chat.update", "ws-connected", "ws-message" */
    events: emitter,

    /** Shut down the server. */
    stop() {
      return new Promise((resolve, reject) => {
        if (wsSocket && !wsSocket.destroyed) wsSocket.destroy();
        server.close(e => e ? reject(e) : resolve());
      });
    },
  };
}
