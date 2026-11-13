// A tiny node:http stand-in for the hub, used only when no hub fixture is already listening
// on 127.0.0.1:8001. Its shapes are copied from the real routes so the transcript the probe
// produces is the transcript an agent would get:
//   GET /api/scan-status  -> 302 /pin + a clearing Set-Cookie  (src/auth.py:113 require_profile)
//                         -> 200 JSON when a profile_session cookie is presented (src/main.py:1674)
//   GET /api/<missing>    -> 404 JSON
//   anything else         -> 405, and LOGGED: the read-only proof asserts this log stays empty
//                            of writes.
//
// Nothing here is a credential: FIXTURE_SESSION is a literal that exists to be redacted.

import { createServer } from "node:http";

export const FIXTURE_SESSION = "fixture-session-not-a-credential";

/** The exact payload src/main.py:1685 returns, idle. */
export const SCAN_STATUS_IDLE = {
  tv_running: false,
  movies_running: false,
  any_running: false,
  recommend_running: false,
  recommend_profile: null,
  recommend_stage: null,
  recommend_done: null,
  recommend_total: null,
  recommend_queued: [],
};

export async function startHttpFixture({ port = 0, host = "127.0.0.1" } = {}) {
  const requests = [];

  const server = createServer((req, res) => {
    requests.push({ method: req.method, path: req.url, at: Date.now() });

    if (req.method !== "GET" && req.method !== "HEAD") {
      res.writeHead(405, { "content-type": "application/json" });
      res.end(JSON.stringify({ detail: "method not allowed" }));
      return;
    }

    if (req.url === "/api/scan-status") {
      const cookie = req.headers.cookie ?? "";
      const authed = cookie.includes(`profile_session=${FIXTURE_SESSION}`);
      if (!authed) {
        res.writeHead(302, {
          location: "/pin",
          "set-cookie": "profile_session=; Max-Age=0; Path=/; HttpOnly; SameSite=Lax",
          "content-type": "text/plain",
        });
        res.end("");
        return;
      }
      const body = JSON.stringify(SCAN_STATUS_IDLE);
      res.writeHead(200, {
        "content-type": "application/json",
        "content-length": Buffer.byteLength(body),
        "cache-control": "no-store",
        "set-cookie": `profile_session=${FIXTURE_SESSION}; Path=/; HttpOnly; SameSite=Lax`,
      });
      res.end(body);
      return;
    }

    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ detail: "Not Found" }));
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, resolve);
  });

  const actual = server.address().port;
  return {
    host,
    port: actual,
    origin: `http://${host}:${actual}`,
    requests,
    writes: () => requests.filter((r) => r.method !== "GET" && r.method !== "HEAD"),
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}
