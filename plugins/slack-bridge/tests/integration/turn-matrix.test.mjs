// Every turn shape a claimed session meets, through the real hooks, a real broker and
// the reply loop: who started the turn, when a Slack message lands in it, and how it
// ends. Each cell checks the same things the operator sees: the message reaches the
// session once, a block is up while the session works on it, and nothing ticks after.
// Typed turns, and turns that end without a Stop, are in tests/lifecycle.
import assert from "node:assert/strict";
import { textEntry, toolEntry } from "../remote/stop-hook-harness.mjs";
import { delay, waitFor } from "./route-harness.mjs";
import { BASH, LINT, QUIET, label, liveBlocks, replay, unread } from "./live-session-harness.mjs";

const ORIGINS = ["slack"];
const TIMINGS = ["mid-tool", "during the reply", "never"];
const ENDINGS = ["text", "no text"];

// A waiter still open after `ms` resolves null: it has neither woken nor left.
const settled = (p, ms) => Promise.race([p, delay(ms).then(() => null)]);
const count = (texts, needle) => texts.join("\n").split(needle).length - 1;

// Returns `{ waiter }`, never the waiter itself: an async function returning it would
// wait for the waiter to finish.
function endTurn(s, text) {
  if (!text) return s.stop();
  return s.stop({ lastMessage: text, flush: [textEntry(`a-${text.length}-${Date.now()}`, text)] });
}

async function cell(s, { timing, ending }) {
  const seen = [];
  await s.prime();
  // An idle session: the last turn's Stop left its waiter open.
  const { waiter: idle } = await endTurn(s, null);

  await s.send("go");
  const wake = await settled(idle, 5_000);
  assert.equal(wake?.status, 2, "the waiter wakes the session with the message");
  seen.push(wake.stderr);
  await s.mirror("UserPromptSubmit", { prompt: wake.stderr });

  s.append(toolEntry("b1", "Bash", BASH.tool_input));
  await s.toolStart();
  await waitFor(() => label(s) === "Bash: npm test" && liveBlocks(s.web).length === 1);

  if (timing === "mid-tool") {
    await s.send("msg");
    await waitFor(() => unread(s) && s.hb.instances.length === 2 && label(s) === "Bash: npm test");
    assert.equal(liveBlocks(s.web).length, 1, "one block, under the message");
    const batch = await s.inbox();
    seen.push(batch.stdout);
    assert.match(batch.stdout, /SLACK: msg/, "the message lands in this turn");
    await waitFor(() => !unread(s));
  }
  if (timing === "during the reply") {
    await s.send("msg");
    await waitFor(() => unread(s) && s.hb.instances.length === 2);
  }

  const { waiter: after } = await endTurn(s, ending === "text" ? "All done." : null);

  if (timing === "during the reply") {
    const wake = await settled(after, 8_000);
    assert.equal(wake?.status, 2, "the Stop's own waiter wakes the session with the message");
    seen.push(wake.stderr);
    await s.mirror("UserPromptSubmit", { prompt: wake.stderr });
    s.append(toolEntry("b2", "Bash", LINT.tool_input));
    await s.toolStart(LINT);
    await waitFor(() => label(s) === "Bash: npm run lint");
    assert.equal(liveBlocks(s.web).length, 1, "the woken turn works in a block");
    await endTurn(s, ending === "text" ? "Answered." : null);
  } else {
    assert.equal(await settled(after, 300), null, "nothing queued, so the waiter waits");
  }

  await waitFor(() => liveBlocks(s.web).length === 0);
  await delay(QUIET * 3);
  assert.deepEqual(liveBlocks(s.web), [], "no block outlives the work");
  assert.ok(s.hb.instances.every((i) => i.stopped), "no clock is left ticking");
  assert.equal(count(seen, "SLACK: go"), 1, "the first message reaches the session once");
  if (timing !== "never") assert.equal(count(seen, "SLACK: msg"), 1, "the message reaches the session once");
}

for (const origin of ORIGINS) {
  for (const timing of TIMINGS) {
    for (const ending of ENDINGS) {
      replay(`a ${origin} turn, a message ${timing}, ending on ${ending}`, (s) => cell(s, { timing, ending }));
    }
  }
}
