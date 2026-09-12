// Repro child for the memory-park exit-13 regression (D3/D6): a leaf parked
// for low memory while nothing else runs must keep the engine's event loop
// alive until the heartbeat notices memory recovered and redrives it. If the
// heartbeat stays unref'd while a leaf sits parked, the loop drains here and
// node exits 13 (unsettled top-level await) before printing anything.
// Run: node memory-park-child.mjs <tmpdir>
import { join } from "node:path";
import { runPlan } from "../../src/scheduler.mjs";
import { fakeSpawnFactory, makeIo } from "./fake-io.mjs";

const dir = process.argv[2];
const spawn = fakeSpawnFactory(() => ({ output: "ok", delayMs: 5 }));
const start = Date.now();
// Low for the first ~150ms (long enough for both leaves to dispatch and the
// second to park), then recovered — proves the redrive fires off the engine's
// own ref'd heartbeat tick, not a park-side timer.
const io = makeIo(spawn, { freeMemMb: () => (Date.now() - start > 150 ? 99999 : 10) });
const a = { id: "a", prompt: "do a", model: "haiku", allowedTools: "Read", cwd: dir, originalCwd: dir, scratchRedirect: false, timeoutMs: 5000, after: [] };
const b = { id: "b", prompt: "do b", model: "haiku", allowedTools: "Read", cwd: dir, originalCwd: dir, scratchRedirect: false, timeoutMs: 5000, after: [] };
const plan = { cwd: dir, resultsDir: join(dir, "run"), concurrency: 2, tasks: [a, b], goal: "" };
const cfg = {
  provider: { mode: "env", url: "http://127.0.0.1:1", authToken: "x", allowedRoots: [] },
  concurrency: 2, timeoutMs: 5000, resultInlineCap: 4000,
  minFreeMemMb: 2048, heartbeatSecs: 0.05,
};
const r = await runPlan(plan, cfg, io);
process.stdout.write(JSON.stringify(Object.fromEntries(r.summary.tasks.map((t) => [t.id, t.state]))));
