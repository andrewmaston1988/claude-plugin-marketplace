import { Worker } from "node:worker_threads";
import { touchHeartbeat } from "./results.mjs";

// The heartbeat beats from its own thread: per-leaf worktree setup runs synchronous
// git on the main thread, and a big repo stalled a main-thread interval past the
// liveness window, so `status` declared a healthy engine dead.
export function startHeartbeat(dir, startedIso, ms) {
  touchHeartbeat(dir, startedIso, process.pid);
  const worker = new Worker(new URL("./heartbeat-worker.mjs", import.meta.url), {
    workerData: { dir, ms, pid: process.pid },
  });
  worker.unref();
  return { stop: () => { worker.terminate(); } };
}
