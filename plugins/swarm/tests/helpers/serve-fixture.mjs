import { mkdtempSync, writeFileSync, rmSync, utimesSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import http from "node:http";
import { createServer } from "../../src/serve/server.mjs";
import { NOW, buildFixture } from "../fixtures/run-fixture.mjs";
import { touchHeartbeat, heartbeatPath } from "../../src/results.mjs";
import { buildSnapshot } from "../../src/serve/estate.mjs";

export const cfg = (over = {}) => ({ quietWarnSecs: 60, dashboard: { port: 0, bind: "127.0.0.1", token: null, ...over } });

export function seedHome() {
  const home = mkdtempSync(join(tmpdir(), "swarm-serve-"));
  const live = join(home, "runs", "C--code-a", "live-1");
  buildFixture(live);
  // find-b carries a prompt but NO result file: the in-flight case, where the prompt is
  // only knowable from this snapshot. `join` is agentless — no prompt, and must stay 404.
  writeFileSync(join(live, "manifest.json"), JSON.stringify({ tasks: [{ id: "find-a", model: "m", prompt: "authored a" }, { id: "find-b", model: "m", prompt: "authored b" }, { id: "fix", model: "m", after: ["find-a"] }, { id: "review", model: "m", after: ["fix"] }, { id: "join", compute: "1" }], digest: { model: "m", instructions: "steer the digest" } }), "utf8");
  writeFileSync(join(live, "results", "find-a.json"), JSON.stringify({ id: "find-a", model: "m", ok: true, output: "ten bullets", tokens: { input: 1, output: 2 }, numTurns: 7, prompt: "secret prompt" }), "utf8");
  writeFileSync(join(live, "results", "find-a.log"), "raw stream json — never served", "utf8");
  const done = join(home, "runs", "C--code-b", "done-1");
  buildFixture(done);
  writeFileSync(join(done, "summary.json"), JSON.stringify({ started: "2026-09-05T00:00:00Z", finished: "2026-09-05T00:30:00Z", tasks: [] }), "utf8");
  writeFileSync(join(done, "report.md"), "# Report\n\nPROVEN — a claim", "utf8");
  // Both logs get explicit stamps: the live one 5 s before NOW, the finished one an
  // hour earlier — otherwise the finished fixture carries the real clock and sorts first.
  const t = (NOW - 5000) / 1000;
  utimesSync(join(live, "run.log"), t, t);
  touchHeartbeat(live, new Date(NOW - 5000).toISOString(), process.pid);
  utimesSync(heartbeatPath(live), t, t);
  const td = (NOW - 3600_000) / 1000;
  utimesSync(join(done, "run.log"), td, td);
  return { home, live, done };
}

// The default `_estate`: rebuilds in-thread on every `current()` (so a test writing a
// fixture then GETting /api/runs sees it immediately, same as the old per-request
// scan) plus its own `pollMs` timer (so the poll/watcher-recovery tests, which fire no
// fs.watch listener at all, still see the clock pick up a change). Tests that care
// about the REAL worker-supervision path inject their own `_estate` or `_Worker`.
function makeInThreadEstate({ home, now, heartbeatMs, quietWarnMs, pollMs }) {
  const cache = new Map();
  let latest = null;
  const listeners = new Set();
  const rebuild = () => {
    const snapshot = buildSnapshot(home, cache, { now: now(), heartbeatMs, quietWarnMs });
    const changed = !latest || snapshot.version !== latest.version;
    latest = snapshot;
    if (changed) for (const cb of listeners) cb(snapshot);
  };
  rebuild();
  const timer = setInterval(rebuild, pollMs);
  return {
    current: () => { rebuild(); return Promise.resolve(latest); },
    refresh: rebuild,
    onSnapshot: (cb) => listeners.add(cb),
    close: () => clearInterval(timer),
  };
}

export async function withServer(opts, fn) {
  const { home } = opts;
  const watchers = [];
  const _watch = (path, listener) => { const w = { path, listener, closed: false, close() { this.closed = true; } }; watchers.push(w); return w; };
  const dashCfg = opts.cfg || cfg();
  const now = () => opts.now ?? NOW;
  // _pollMs defaults slow: only the poll tests opt into a fast tick, so no other
  // test's frame counting can be perturbed by a liveness broadcast landing mid-window.
  const pollMs = opts.pollMs ?? 60_000;
  const seams = opts.seams || {};
  const estateSeam = !seams._estate && !seams._Worker
    ? { _estate: makeInThreadEstate({ home, now, heartbeatMs: Math.max(50, (dashCfg.heartbeatSecs ?? 15) * 1000), quietWarnMs: (dashCfg.quietWarnSecs ?? 60) * 1000, pollMs }) }
    : {};
  const server = createServer({ home, cfg: dashCfg, now, _watch, _heartbeatMs: opts.heartbeatMs ?? 60_000, _debounceMs: 30, _pollMs: pollMs, ...estateSeam, ...seams });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const port = server.address().port;
  const get = (path, { raw = false } = {}) => new Promise((resolve, reject) => {
    http.get({ host: "127.0.0.1", port, path }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (c) => { body += c; });
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: raw ? body : tryJson(body) }));
    }).on("error", reject);
  });
  try { return await fn({ get, port, watchers, server, home }); } finally { server.closeAllConnections(); await new Promise((r) => server.close(r)); }
}
const tryJson = (s) => { try { return JSON.parse(s); } catch { return s; } };
