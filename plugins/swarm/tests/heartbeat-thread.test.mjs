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
    while (stamp(dir) <= Date.parse(started) && Date.now() - t0 < 5000) await new Promise((r) => setTimeout(r, 20));
    const blockStart = Date.now();
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 400);
    assert.ok(stamp(dir) >= blockStart + 150, "no beat landed while the main thread was blocked");
  } finally {
    beat.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});
