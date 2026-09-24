import { workerData } from "node:worker_threads";
import { touchHeartbeat } from "./results.mjs";

const { dir, ms, pid } = workerData;
setInterval(() => {
  try { touchHeartbeat(dir, new Date().toISOString(), pid); } catch { /* results dir gone at teardown */ }
}, ms);
