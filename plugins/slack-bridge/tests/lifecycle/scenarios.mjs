// The turn lifecycle as the Claude Code hooks reference describes it, crossed with
// when a Slack message lands. Each cell plays one turn through session-sim and
// scores what the operator sees, so two builds can be compared cell by cell.
//
// From the hooks reference (code.claude.com/docs/en/hooks):
// - Stop "Does not run if the stoppage occurred due to a user interrupt. API errors
//   fire StopFailure instead."
// - A blocked Stop continues the turn ("The conversation continues"), with
//   stop_hook_active set, and no new prompt.
// - UserPromptSubmit also fires on /loop and scheduled tasks, so for these hooks a
//   scheduled turn is a typed one.
// - Async hook output arrives "on the next conversation turn"; an asyncRewake exit 2
//   "wakes Claude immediately even when the session is idle".
import { delay } from "../integration/route-harness.mjs";
import { textEntry, toolEntry, userEntry } from "../remote/stop-hook-harness.mjs";

export const STARTS = ["slack wake", "typed", "stop continuation"];
export const ENDS = ["stop", "stop failure", "interrupt"];
export const TIMINGS = ["mid-tool", "after the last batch", "none"];

let n = 0;
const uid = () => `e${++n}`;
// The model's time to answer: no assistant entry exists the instant a hook fires.
const MODEL_MS = 250;

async function until(pred, ms) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (pred()) return true;
    await delay(50);
  }
  return pred();
}

const has = (s, needle) => s.deliveries.filter((d) => d.text.includes(needle));

async function tool(s, command) {
  const id = uid();
  const t = { tool_name: "Bash", tool_input: { command }, tool_use_id: "t" + id };
  await delay(MODEL_MS);
  s.append(toolEntry(id, "Bash", t.tool_input));
  await s.fire("PreToolUse", t);
  return t;
}

async function toolDone(s, t) {
  await s.fire("PostToolUse", { ...t, tool_response: "ok" });
  await s.fire("PostToolBatch", { tool_calls: [{ ...t, tool_response: "ok" }] });
}

// The blocks up while the session works: given the async status hook time to land.
async function blocksWhileWorking(s) {
  await until(() => s.liveBlocks().length > 0, 1_500);
  return s.liveBlocks().length;
}

async function endTurn(s, end, text) {
  if (end === "interrupt") return;
  if (end === "stop failure") {
    await s.fire("StopFailure", { error: "server_error", last_assistant_message: "API Error: overloaded" });
    return;
  }
  // The turn's last entry flushes after the Stop hooks start.
  const stop = s.fire("Stop", { stop_hook_active: false, ...(text ? { last_assistant_message: text } : {}) });
  await delay(150);
  if (text) s.append(textEntry(uid(), text));
  await stop;
}

async function wokenTurn(s, wake) {
  await s.fire("UserPromptSubmit", { prompt: `<task-notification>\n${wake}` });
  const t = await tool(s, "npm run lint");
  const blocks = await blocksWhileWorking(s);
  await toolDone(s, t);
  await endTurn(s, "stop", "Answered.");
  return blocks;
}

// One cell. The session starts idle, its last turn ended in a Stop, so a waiter is open.
export async function runCell(s, { start, end, timing }) {
  s.append(userEntry(uid(), "before"), textEntry(uid(), "BEFORE THE SEIZE"));
  await s.fire("PostToolUse", { tool_name: "Bash", tool_input: {}, tool_use_id: "prime" });
  await endTurn(s, "stop", null);

  if (start === "slack wake") {
    await s.send("go");
    if (!(await until(() => s.wakes.length > 0, 6_000))) return { failed: "the first message never woke the session" };
    await s.fire("UserPromptSubmit", { prompt: `<task-notification>\n${s.wakes[0]}` });
  } else {
    await s.fire("UserPromptSubmit", { prompt: "run it" });
  }
  if (start === "stop continuation") {
    const t = await tool(s, "npm run build");
    await toolDone(s, t);
    // A sibling plugin's Stop hook blocks; every Stop entry of this plugin still ran.
    await endTurn(s, "stop", "Checking.");
  }

  const t = await tool(s, "npm test");
  if (timing === "mid-tool") { await s.send("msg"); await delay(500); }
  await toolDone(s, t);
  if (timing === "after the last batch") { await s.send("msg"); await delay(500); }

  let block = null;
  if (has(s, "SLACK: msg").some((d) => d.how === "in-turn")) {
    const fix = await tool(s, "npm run fix");
    block = await blocksWhileWorking(s);
    await toolDone(s, fix);
  }
  await endTurn(s, end, "All done.");

  // A wake taken during the turn is delivered once it has ended.
  if (timing !== "none" && block === null) {
    if (await until(() => has(s, "SLACK: msg").length > 0, 6_000)) {
      block = await wokenTurn(s, has(s, "SLACK: msg")[0].text);
    }
  }
  await s.settle();
  const ticking = s.ticking();

  await s.send("ping");
  const reachable = await until(() => has(s, "SLACK: ping").length > 0, 8_000);

  const seen = timing === "none" ? null : has(s, "SLACK: msg").length;
  const when = timing === "none" ? null
    : has(s, "SLACK: msg").some((d) => d.how === "in-turn") ? "in-turn"
      : seen > 0 ? "after the turn" : "never";
  return { seen, when, block, ticking, reachable };
}

export const CELLS = STARTS.flatMap((start) => ENDS.flatMap((end) => TIMINGS.map((timing) => ({ start, end, timing }))));
export const cellName = ({ start, end, timing }) => `${start} · message ${timing} · ends ${end}`;
