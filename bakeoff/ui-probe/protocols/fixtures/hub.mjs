// Is a hub fixture already listening on 127.0.0.1:8001? The bake-off must not start one (that
// is RQ9's fixture, owned by another lane) and must never touch prod :8000. A refused or
// silent connect is the answer "no", and the caller falls back to the local fixture server.
//
// `net` is injected at call time so the offline smoke test can drive this without a socket.

import * as nodeNet from "node:net";

export const HUB_HOST = "127.0.0.1";
export const HUB_PORT = 8001;

export function probeListening({ host = HUB_HOST, port = HUB_PORT, timeoutMs = 600, net = nodeNet } = {}) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (listening) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(listening);
    };
    const socket = net.connect({ host, port });
    socket.setTimeout(timeoutMs);
    socket.once("connect", () => done(true));
    socket.once("timeout", () => done(false));
    socket.once("error", () => done(false));
  });
}
