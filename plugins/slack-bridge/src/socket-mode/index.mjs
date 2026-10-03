import { EventEmitter } from "node:events";

const BACKOFF_CAP_MS = 30_000;
// A half-open socket never fires `close`, so silence is the only signal. Slack's
// own SDK treats 30 s without a server ping as dead; three times that avoids churn.
const STALE_MS = 90_000;

export function createSocketModeClient({ appToken, log, _WebSocket, _staleMs = STALE_MS }) {
  const WS = _WebSocket ?? WebSocket; // injectable for tests
  const emitter = new EventEmitter();

  let ws = null;
  let stopped = false;
  let noReconnect = false;
  let backoffMs = 1_000;
  let reconnectTimer = null;
  let watchdog = null;
  let attempt = 0; // a connect the watchdog gave up on must not land later

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
    if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
    if (watchdog) { clearTimeout(watchdog); watchdog = null; }
  }

  // Reset on every frame, and armed from the start of connect() so a hung URL
  // fetch or handshake is covered too. On expiry, reconnect directly rather than
  // waiting for `close`: a close handshake on a dead link may never complete.
  function armWatchdog(socket) {
    if (watchdog) clearTimeout(watchdog);
    watchdog = setTimeout(() => {
      watchdog = null;
      if (stopped || socket !== ws) return;
      log.warn("no frame from Slack — forcing reconnect", { staleMs: _staleMs });
      ws = null; // its late `close` must not schedule a second reconnect
      socket?.close();
      scheduleReconnect();
    }, _staleMs);
    watchdog.unref?.();
  }

  function scheduleReconnect() {
    clearTimers();
    log.info("scheduling reconnect", { backoffMs });
    reconnectTimer = setTimeout(() => connect(), backoffMs);
    backoffMs = Math.min(backoffMs * 2, BACKOFF_CAP_MS);
  }

  function connect() {
    if (stopped) return;
    const mine = ++attempt;
    armWatchdog(null);

    getWssUrl().then(url => {
      if (stopped || mine !== attempt) return;
      log.info("connecting", { url: url.replace(/\?.*/, "") });
      const socket = new WS(url);
      ws = socket;
      armWatchdog(socket);

      socket.addEventListener("open", () => {
        log.info("socket open, waiting for hello");
        armWatchdog(socket);
      });

      socket.addEventListener("message", ({ data }) => {
        if (socket !== ws) return; // abandoned by the watchdog
        let msg;
        armWatchdog(socket);
        try { msg = JSON.parse(data); } catch { return; }

        if (msg.type === "hello") {
          log.info("connected");
          backoffMs = 1_000; // reset on successful hello
          // No client→server ping: Slack Socket Mode keepalive is server-driven.
          // The server pings us (handled below → we pong), sends `disconnect` for
          // session rotation, and the socket `close` event fires on network death.
          // Slack never answers a client-sent {type:"ping"}, so sending one only
          // causes a perpetual pong-timeout reconnect churn. Reconnect purely on
          // disconnect / close below.
          emitter.emit("connect");
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
        if (socket !== ws) return; // abandoned by the watchdog
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
      if (mine !== attempt) return;
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
