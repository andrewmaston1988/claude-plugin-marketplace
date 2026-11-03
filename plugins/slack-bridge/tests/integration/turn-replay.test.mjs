// Integration: whole turns through the real hook entry points, a real broker and the
// reply loop, with only Slack faked. The order the operator sees, and the one block
// at the bottom, exist only across all three.
import assert from "node:assert/strict";
import { PRIMING_LINE } from "../../src/remote/waiter.mjs";
import { textEntry, toolEntry, userEntry } from "../remote/stop-hook-harness.mjs";
import { delay, hasUpdate, idxOf, posted, waitFor } from "./route-harness.mjs";
import { BASH, LINT, QUIET, label, liveBlocks, replay } from "./live-session-harness.mjs";

const replyIdx = (s, text) => idxOf(s.web, ([ty, p]) => ty === "update" && p.text?.includes(text));

replay("a Slack turn lands in order, with one block at the bottom the whole way", async (s) => {
  await s.prime();
  assert.deepEqual(s.web.calls, [], "text from before the seize stays out of Slack");

  await s.send("go");
  await waitFor(() => label(s) === "Not read yet");

  // The waiter's take: the read receipt clears the label.
  await s.broker.takeMessages(s.peer);
  await waitFor(() => label(s) === "");

  // Text goes out as the tool starts, and a block goes back under it with the clock.
  s.append(textEntry("a1", "Running the tests"), toolEntry("b1", "Bash", BASH.tool_input));
  await s.toolStart();
  await waitFor(() => hasUpdate(s.web, "Running the tests") && s.hb.instances.length === 2 && label(s) === "Bash: npm test");
  const [first, second] = s.hb.instances;
  assert.equal(second.startedAt, first.startedAt, "the clock carries on");
  assert.deepEqual(liveBlocks(s.web), [second.ts]);
  const blockAfterReply = idxOf(s.web, ([ty, p]) => ty === "post" && p._ts === second.ts);
  assert.ok(replyIdx(s, "Running the tests") < blockAfterReply, "the block sits under the reply");

  // A message during the tool waits behind a label, in a block under it.
  await s.send("stop that");
  await waitFor(() => label(s) === "Not read yet · Bash: npm test" && liveBlocks(s.web).length === 1);
  assert.deepEqual(liveBlocks(s.web), [s.hb.instances.at(-1).ts]);

  // The tool batch ends: the session gets the message in this turn, and Slack hears.
  const delivered = await s.inbox();
  assert.deepEqual(JSON.parse(delivered.stdout), {
    hookSpecificOutput: { hookEventName: "PostToolBatch", additionalContext: `${PRIMING_LINE}\nSLACK: stop that\n` },
  });
  await waitFor(() => label(s) === "Bash: npm test");

  // The final reply takes the last block, and nothing reopens under it.
  s.append(textEntry("a2", "Stopped."));
  await s.mirror("Stop", { last_assistant_message: "Stopped." });
  await waitFor(() => hasUpdate(s.web, "Stopped.") && liveBlocks(s.web).length === 0);
  await delay(QUIET * 2);
  assert.deepEqual(liveBlocks(s.web), []);
  assert.ok(replyIdx(s, "Running the tests") < replyIdx(s, "Stopped."), "the replies land in order");
  assert.ok(s.hb.instances.every((i) => i.stopped), "no clock is left ticking");
});

replay("a typed turn opens a block on the prompt and closes it with the reply", async (s) => {
  await s.prime();
  await s.mirror("UserPromptSubmit", { prompt: "run it" });
  await waitFor(() => posted(s.web, "run it") && s.hb.instances.length === 1);
  assert.equal(liveBlocks(s.web).length, 1);

  s.append(toolEntry("b1", "Bash", BASH.tool_input));
  await s.toolStart();
  await waitFor(() => label(s) === "Bash: npm test");

  s.append(textEntry("a1", "Done."));
  await s.mirror("Stop", { last_assistant_message: "Done." });
  await waitFor(() => hasUpdate(s.web, "Done.") && liveBlocks(s.web).length === 0);
});

replay("a turn ending on text Slack already has takes the block away", async (s) => {
  await s.prime();
  await s.mirror("UserPromptSubmit", { prompt: "run it" });
  await waitFor(() => s.hb.instances.length === 1);

  s.append(textEntry("a1", "All done"), toolEntry("b1", "Bash", BASH.tool_input));
  await s.toolStart();
  await waitFor(() => hasUpdate(s.web, "All done") && s.hb.instances.length === 2);
  assert.equal(liveBlocks(s.web).length, 1);

  await s.mirror("Stop", { last_assistant_message: "All done" });
  await waitFor(() => liveBlocks(s.web).length === 0);
});

replay("a turn that read its message and wrote nothing into the block takes it away", async (s) => {
  await s.prime();
  await s.send("run the tests");
  await waitFor(() => label(s) === "Not read yet");
  await s.broker.takeMessages(s.peer);
  await waitFor(() => label(s) === "");

  s.append(toolEntry("b1", "Bash", BASH.tool_input));
  await s.toolStart();
  await waitFor(() => label(s) === "Bash: npm test");

  await s.mirror("Stop");
  await waitFor(() => liveBlocks(s.web).length === 0);
  assert.ok(s.hb.instances.every((i) => i.stopped), "no clock is left ticking");
});

// A message sent after the turn's last tool batch: the Stop's own waiter takes it
// and wakes the next turn, which must still find a block to work in.
async function messageAfterLastBatch(s) {
  await s.prime();
  await s.send("first");
  await waitFor(() => label(s) === "Not read yet");
  await s.broker.takeMessages(s.peer);
  s.append(toolEntry("b1", "Bash", BASH.tool_input));
  await s.toolStart();
  await waitFor(() => label(s) === "Bash: npm test");
  await s.send("second");
  await waitFor(() => label(s) === "Not read yet · Bash: npm test");
}

// The woken turn's first tool: a status in the one block at the bottom.
async function wokenTurnWorks(s, waiter) {
  assert.equal(waiter.status, 2, waiter.stderr);
  assert.match(waiter.stderr, /SLACK: second/);
  s.append(userEntry("u2", "second"), toolEntry("b2", "Bash", LINT.tool_input));
  await s.toolStart(LINT);
  await waitFor(() => label(s) === "Bash: npm run lint");
  assert.equal(liveBlocks(s.web).length, 1, "the woken turn works in a block");
}

replay("a turn ending on late text leaves the woken turn a block under its reply", async (s) => {
  await messageAfterLastBatch(s);
  const waiter = await (await s.stop({ lastMessage: "Done with the first.", flush: [textEntry("a1", "Done with the first.")] })).waiter;
  await waitFor(() => hasUpdate(s.web, "Done with the first."));
  await wokenTurnWorks(s, waiter);
  const live = liveBlocks(s.web)[0];
  assert.ok(replyIdx(s, "Done with the first.") < idxOf(s.web, ([ty, p]) => ty === "post" && p._ts === live), "the block sits under the reply");
});

replay("a turn ending with no text leaves the woken turn its message's block", async (s) => {
  await messageAfterLastBatch(s);
  await wokenTurnWorks(s, await (await s.stop()).waiter);
});

replay("a reply to an unread message keeps a block saying so past the end of the turn", async (s) => {
  await s.prime();
  await s.send("are you there");
  await waitFor(() => label(s) === "Not read yet");

  s.append(textEntry("a1", "An older answer"), toolEntry("b1", "Bash", BASH.tool_input));
  await s.toolStart();
  await waitFor(() => hasUpdate(s.web, "An older answer") && label(s) === "Not read yet · Bash: npm test");

  await s.mirror("Stop");
  await delay(QUIET * 2);
  assert.deepEqual(liveBlocks(s.web), [s.hb.instances.at(-1).ts], "the message still waits for its answer");
  assert.equal(label(s), "Not read yet · Bash: npm test");
});
