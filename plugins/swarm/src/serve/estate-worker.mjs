// worker_threads entry: rebuilds the estate snapshot off the request/event-loop
// path and posts it back only when the version moves. Single-flight rebuild
// mirrors live.js's browser-side singleFlight — a poll tick or a refresh message
// arriving mid-rebuild sets `dirty` and reruns once, instead of overlapping scans.
import { parentPort, workerData } from "node:worker_threads";
import { buildSnapshot } from "./estate.mjs";

const { home, pollMs, heartbeatMs, quietWarnMs } = workerData;
const cache = new Map();
let lastVersion = null;

function singleFlight(fn) {
  let running = false;
  let dirty = false;
  const run = () => {
    running = true;
    Promise.resolve().then(fn).catch(() => {}).finally(() => {
      running = false;
      if (dirty) { dirty = false; run(); }
    });
  };
  return () => { if (running) { dirty = true; return; } run(); };
}

const rebuild = singleFlight(() => {
  let snapshot;
  // A failing build must be visible: report it rather than let singleFlight's
  // catch swallow it and leave every request on the in-thread fallback, silently.
  try { snapshot = buildSnapshot(home, cache, { now: Date.now(), heartbeatMs, quietWarnMs }); }
  catch (e) { parentPort.postMessage({ type: "build-error", msg: String(e?.stack ?? e) }); return; }
  if (snapshot.version === lastVersion) return;
  lastVersion = snapshot.version;
  parentPort.postMessage({ type: "snapshot", version: snapshot.version, rows: snapshot.rows });
});

parentPort.on("message", (msg) => { if (msg?.type === "refresh") rebuild(); });
setInterval(rebuild, pollMs);
rebuild();
