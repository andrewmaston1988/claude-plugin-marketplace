// Repro child for the exit-13 regression: a leaf parked in retry backoff while
// nothing else runs must keep the engine's event loop alive. If the backoff
// timer is unref'd the loop drains here and node exits 13 (unsettled top-level
// await) before printing anything. Run: node backoff-park-child.mjs <tmpdir>
import { join } from "node:path";
import { runPlan } from "../../src/scheduler.mjs";
import { fakeSpawnFactory, makeIo } from "./fake-io.mjs";

const dir = process.argv[2];
let n = 0;
const spawn = fakeSpawnFactory(() => (++n === 1 ? { exit: 1, output: "429 rate limit" } : { output: "recovered" }));
const io = makeIo(spawn);
const task = {
  id: "flaky", prompt: "do flaky", model: "haiku", allowedTools: "Read",
  cwd: dir, originalCwd: dir, scratchRedirect: false, timeoutMs: 5000, after: [],
};
const plan = { cwd: dir, resultsDir: join(dir, "run"), concurrency: 2, tasks: [task], goal: "" };
const cfg = {
  provider: { mode: "env", url: "http://127.0.0.1:1", authToken: "x", allowedRoots: [] },
  concurrency: 2, timeoutMs: 5000, resultInlineCap: 4000,
  retry: { rateLimited: 2, backoffMs: 250 },
};
const r = await runPlan(plan, cfg, io);
process.stdout.write(JSON.stringify(Object.fromEntries(r.summary.tasks.map((t) => [t.id, t.state]))));
