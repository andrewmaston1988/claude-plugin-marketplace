// The heartbeat must keep beating while the main thread is blocked — synchronous
// worktree git on a large repo once starved it past the liveness window.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startHeartbeat } from "../src/heartbeat.mjs";
import { heartbeatPath } from "../src/results.mjs";

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

test("a reader hammering the heartbeat never sees it empty, and every beat lands", () => {
  const dir = mkdtempSync(join(tmpdir(), "swarm-hb-"));
  const beat = startHeartbeat(dir, new Date().toISOString(), 1);
  try {
    let unparseable = 0;
    let errors = 0;
    const seen = new Set();
    const end = Date.now() + 2000;
    while (Date.now() < end) {
      try {
        const s = stamp(dir);
        if (Number.isNaN(s)) unparseable++;
        else seen.add(s);
      } catch { errors++; }
    }
    assert.equal(unparseable, 0, `${unparseable} unparseable reads`);
    assert.equal(errors, 0, `${errors} read errors`);
    assert.ok(seen.size >= 100, `only ${seen.size} distinct stamps seen — beats were lost`);
  } finally {
    beat.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});
