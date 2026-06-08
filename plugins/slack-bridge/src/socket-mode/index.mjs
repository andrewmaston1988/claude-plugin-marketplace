import { EventEmitter } from "node:events";

const BACKOFF_CAP_MS = 30_000;
const PING_INTERVAL_MS = 30_000;
const PONG_TIMEOUT_MS = 10_000;

export function createSocketModeClient({ appToken, log, _WebSocket }) {
  const WS = _WebSocket ?? WebSocket; // injectable for tests
  const emitter = new EventEmitter();

  let ws = null;
  let stopped = false;
  let noReconnect = false;
  let backoffMs = 1_000;
  let pingTimer = null;
  let pongTimer = null;
  let reconnectTimer = null;

  async function getWssUrl() {
    const res = await fetch("https://slack.com/api/apps.connections.open", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${appToken}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
    });
    const json = await res.json();
    if (!json.ok) {
      const err = new Error(`apps.connections.open: ${json.error}`);
      err.slackError = json.error;
      throw err;
    }
    return json.url;
  }

  function clearTimers() {
    if (pingTimer) { clearInterval(pingTimer); pingTimer = null; }
    if (pongTimer) { clearTimeout(pongTimer); pongTimer = null; }
    if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
  }

  function scheduleReconnect() {
    clearTimers();
    log.info("scheduling reconnect", { backoffMs });
    reconnectTimer = setTimeout(() => connect(), backoffMs);
    backoffMs = Math.min(backoffMs * 2, BACKOFF_CAP_MS);
  }

  function startPing(socket) {
    pingTimer = setInterval(() => {
      if (socket.readyState !== socket.OPEN) return;
      if (pongTimer) { clearTimeout(pongTimer); pongTimer = null; }
      socket.send(JSON.stringify({ type: "ping" }));
      pongTimer = setTimeout(() => {
        log.warn("pong timeout, reconnecting");
        socket.close();
      }, PONG_TIMEOUT_MS);
    }, PING_INTERVAL_MS);
  }

  function connect() {
    if (stopped) return;

    getWssUrl().then(url => {
      log.info("connecting", { url: url.replace(/\?.*/, "") });
      const socket = new WS(url);
      ws = socket;

      socket.addEventListener("open", () => {
        log.info("socket open, waiting for hello");
      });

      socket.addEventListener("message", ({ data }) => {
        let msg;
        try { msg = JSON.parse(data); } catch { return; }

        if (msg.type === "hello") {
          log.info("connected");
          backoffMs = 1_000; // reset on successful hello
          startPing(socket);
          emitter.emit("connect");
          return;
        }

        if (msg.type === "pong") {
          if (pongTimer) { clearTimeout(pongTimer); pongTimer = null; }
          return;
        }

        if (msg.type === "ping") {
          socket.send(JSON.stringify({ type: "pong", reply_to: msg.reply_to }));
          return;
        }

        if (msg.type === "disconnect") {
          log.warn("disconnect from Slack", { reason: msg.reason });
          if (msg.reason === "link_disabled") {
            noReconnect = true; // must be set before socket.close() fires the close event
          }
          socket.close();
          if (msg.reason === "link_disabled") {
            log.info("link_disabled — not reconnecting");
          } else {
            scheduleReconnect();
          }
          return;
        }

        if (msg.type === "events_api") {
          const ack = () => {
            socket.send(JSON.stringify({ envelope_id: msg.envelope_id }));
          };
          emitter.emit("event", { payload: msg.payload, ack });
          return;
        }

        if (msg.type === "slash_commands") {
          const ack = () => {
            socket.send(JSON.stringify({ envelope_id: msg.envelope_id }));
          };
          emitter.emit("slash_command", { payload: msg.payload, ack });
        }
      });

      socket.addEventListener("close", ({ code, reason }) => {
        clearTimers();
        if (stopped || noReconnect) return;
        log.warn("socket closed", { code, reason: String(reason) });
        scheduleReconnect();
      });

      socket.addEventListener("error", (err) => {
        if (stopped) return; // suppress teardown errors
        log.error("socket error", { message: err.message });
        if (emitter.listenerCount("error") > 0) emitter.emit("error", err);
      });
    }).catch(err => {
      log.error("failed to get WSS URL", { message: err.message });
      scheduleReconnect();
    });
  }

  return {
    start() {
      stopped = false;
      connect();
    },
    stop() {
      stopped = true;
      clearTimers();
      if (ws) { ws.close(); ws = null; }
    },
    on: (event, handler) => emitter.on(event, handler),
    off: (event, handler) => emitter.off(event, handler),
  };
}
