// The heartbeat must keep beating while the main thread is blocked — synchronous
// worktree git on a large repo once starved it past the liveness window.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startHeartbeat } from "../src/heartbeat.mjs";
import { heartbeatPath, touchHeartbeat } from "../src/results.mjs";
import { Worker } from "node:worker_threads";
import { once } from "node:events";

const stamp = (dir) => Date.parse(readFileSync(heartbeatPath(dir), "utf8").split(" ")[0]);

test("the heartbeat advances while the main thread is blocked", async () => {
  const dir = mkdtempSync(join(tmpdir(), "swarm-hb-"));
  const started = new Date(Date.now() - 60_000).toISOString();
  const beat = startHeartbeat(dir, started, 50);
  try {
    assert.equal(readFileSync(heartbeatPath(dir), "utf8"), `${started} ${process.pid}\n`);
    // Let the beat get going before blocking, so a slow start can't read as starvation.
    const t0 = Date.now();
    // `!(a > b)`, not `a <= b`: a torn read parses to NaN and must keep the loop waiting.
    while (!(stamp(dir) > Date.parse(started)) && Date.now() - t0 < 5000) await new Promise((r) => setTimeout(r, 20));
    const blockStart = Date.now();
    // Long enough that a loaded CI runner descheduling the worker cannot miss it; a beat on
    // the main thread lands none at all, however long the block.
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1000);
    assert.ok(stamp(dir) >= blockStart + 150, "no beat landed while the main thread was blocked");
  } finally {
    beat.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

// The writer runs in its own worker and counts what it throws: a lost beat is a writer error
// (rename's EPERM on Windows) whatever the load, where a beat-rate floor starves on a busy box.
const WRITER = `
const { workerData, parentPort } = require("node:worker_threads");
import(workerData.url).then(({ touchHeartbeat }) => {
  let writes = 0, errors = 0;
  const end = Date.now() + workerData.ms;
  while (Date.now() < end) {
    try { touchHeartbeat(workerData.dir, new Date().toISOString(), process.pid); writes++; } catch { errors++; }
  }
  parentPort.postMessage({ writes, errors });
});`;

test("a reader hammering the heartbeat never sees it empty, and every beat lands", async () => {
  const dir = mkdtempSync(join(tmpdir(), "swarm-hb-"));
  touchHeartbeat(dir, new Date().toISOString(), process.pid);
  const url = new URL("../src/results.mjs", import.meta.url).href;
  const writer = new Worker(WRITER, { eval: true, workerData: { dir, url, ms: 2000 } });
  const done = once(writer, "message");
  try {
    let reads = 0;
    let unparseable = 0;
    let errors = 0;
    const end = Date.now() + 2000;
    while (Date.now() < end) {
      try {
        if (Number.isNaN(stamp(dir))) unparseable++;
        reads++;
      } catch { errors++; }
    }
    const [w] = await done;
    assert.equal(unparseable, 0, `${unparseable} of ${reads} reads unparseable`);
    assert.equal(errors, 0, `${errors} read errors`);
    assert.equal(w.errors, 0, `${w.errors} of ${w.writes + w.errors} beats threw — lost`);
    assert.ok(w.writes > 0 && reads > 0, "the writer and the reader both ran");
  } finally {
    await writer.terminate();
    rmSync(dir, { recursive: true, force: true });
  }
});
