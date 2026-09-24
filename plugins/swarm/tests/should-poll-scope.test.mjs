// The 5 s full refetch belongs to the run screens. currentRun outlives them, so reading
// it on any view made Cost and Performance blink every poll after a live run was opened.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const live = () => {
  const ctx = { window: {} };
  vm.createContext(ctx);
  vm.runInContext(readFileSync(new URL("../src/serve/live.js", import.meta.url), "utf8"), ctx);
  return ctx.window.swarmLive;
};
const open = { finishedMs: null, abortedMs: null, stoppedMs: null };

test("shouldPoll: an unfinished run polls only on the run-scoped screens", () => {
  const { shouldPoll } = live();
  for (const name of ["run", "node", "leaf", "digest", "report"]) assert.equal(shouldPoll({ name }, open, 0), true, name);
  for (const name of ["cost", "perf", "usage"]) assert.equal(shouldPoll({ name }, open, 0), false, name);
});
