import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

// live.js is a browser static, never imported as a module — load it in a bare
// vm context the way the real page does (a `window` global and nothing else),
// then assert against the contract it hangs off `window.swarmLive`.
const LIVE_JS = fileURLToPath(new URL("../src/serve/live.js", import.meta.url));

function loadLive() {
  const context = { window: {} };
  vm.createContext(context);
  vm.runInContext(readFileSync(LIVE_JS, "utf8"), context, { filename: "live.js" });
  return context.window.swarmLive;
}

test("waveOpen: open unless manually closed — size and settledness have no say (L1)", () => {
  const { waveOpen } = loadLive();
  const closedWaves = new Set(["w-closed"]);
  assert.equal(waveOpen("w-open", closedWaves), true);
  assert.equal(waveOpen("w-closed", closedWaves), false);
  // A 12-member wave and a wave whose tasks are all `ok` have no representation in this
  // signature at all — that absence is defect (c)'s fix: `big`/`settled` cannot exist
  // here to force a collapse.
  assert.equal(waveOpen("w-big-12-members", closedWaves), true);
  assert.equal(waveOpen("w-all-settled", closedWaves), true);
});

test("projectOpen: closed unless manually opened — the (d) inversion (L2)", () => {
  const { projectOpen } = loadLive();
  const openProjects = new Set(["p-open"]);
  assert.equal(projectOpen("p-open", openProjects), true);
  assert.equal(projectOpen("p-untouched", openProjects), false);
});

test("elapsedText: running moves with now; finished is fixed regardless of now; pending is null (L3)", () => {
  const { elapsedText } = loadLive();
  const running = { state: "running", startedMs: 1000 };
  assert.notEqual(elapsedText(running, 2000), elapsedText(running, 3000));
  const finished = { state: "ok", durationMs: 5000 };
  assert.equal(elapsedText(finished, 10_000), elapsedText(finished, 999_000));
  assert.equal(elapsedText({ state: "pending" }, 10_000), null);
});

test("quietSecs: only a running task with lastEventMs reports an age, and it moves with now (L4)", () => {
  const { quietSecs } = loadLive();
  const running = { state: "running", lastEventMs: 0 };
  assert.equal(quietSecs(running, 60_000), 60);
  assert.notEqual(quietSecs(running, 60_000), quietSecs(running, 61_000));
  assert.equal(quietSecs({ state: "ok", lastEventMs: 0 }, 60_000), null);
});

test("agoText: the existing ago() thresholds preserved exactly — 59s/61s/3601s/86401s (L5)", () => {
  const { agoText } = loadLive();
  const now = 100_000_000;
  assert.equal(agoText(now - 59_000, now), "59s ago");
  assert.equal(agoText(now - 61_000, now), "1 min ago");
  assert.equal(agoText(now - 3601_000, now), "1 h ago");
  assert.equal(agoText(now - 86401_000, now), "1 d ago");
});

test("runEnded/shouldPoll: each terminal field on its own, a run not yet fetched, and the runs-list always polls (L6)", () => {
  const { runEnded, shouldPoll } = loadLive();
  const open = { finishedMs: null, abortedMs: null, staleMs: null };
  assert.equal(runEnded(open), false);
  assert.equal(shouldPoll({ name: "run" }, open, 0), true);
  for (const field of ["finishedMs", "abortedMs", "staleMs"]) {
    const ended = { ...open, [field]: 123 };
    assert.equal(runEnded(ended), true, field);
    assert.equal(shouldPoll({ name: "run" }, ended, 0), false, field);
  }
  assert.equal(shouldPoll({ name: "run" }, null, 0), false, "no run fetched yet");
  assert.equal(shouldPoll({ name: "runs" }, null, 0), true, "the estate view has no single run to end");
});

test("loadScript: resolves on load, rejects on error rather than swallowing it (L7)", async () => {
  // Pins the contract page.html's own bootstrap loader must satisfy — it cannot
  // depend on this copy for loading live.js itself (chicken-and-egg), but the
  // reject-on-error behaviour is what today's loadPerfJs gets wrong.
  const { loadScript } = loadLive();
  let created;
  const fakeDoc = { createElement: () => { created = {}; return created; }, head: { appendChild: () => {} } };

  const ok = loadScript("/live.js", fakeDoc);
  created.onload();
  await assert.doesNotReject(ok);

  const err = loadScript("/live.js", fakeDoc);
  created.onerror();
  await assert.rejects(err);
});
