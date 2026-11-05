// The turn lifecycle crossed with when a Slack message lands. Each cell plays one
// turn through session-sim and scores what the operator sees, so builds compare.
import { delay } from "../integration/route-harness.mjs";
import { textEntry, toolEntry, userEntry } from "../remote/stop-hook-harness.mjs";

// A scheduled or /loop turn fires UserPromptSubmit too, so it plays as "typed".
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
  // Sessions say what they are about to run, so text lands just before each status.
  s.append(textEntry(uid(), `Running ${command}.`), toolEntry(id, "Bash", t.tool_input));
  await s.fire("PreToolUse", t);
  return t;
}

async function toolDone(s, t) {
  await s.fire("PostToolUse", { ...t, tool_response: "ok" });
  await s.fire("PostToolBatch", { tool_calls: [{ ...t, tool_response: "ok" }] });
}

// The blocks up while the session works, once its hooks have landed and any reply
// has had its quiet gap: a block about to take its text is not a second block.
async function blocksWhileWorking(s) {
  await s.hooksDone();
  await s.settle();
  return s.liveBlocks().length;
}

// Hooks reference: Stop "does not run if the stoppage occurred due to a user
// interrupt. API errors fire StopFailure instead."
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
    // A sibling plugin's Stop hook blocks: every Stop entry of this plugin still ran,
    // and the turn continues with stop_hook_active set and no new prompt.
    await endTurn(s, "stop", "Checking.");
  }

  const t = await tool(s, "npm test");
  // The turn has just begun, often within seconds of the last turn-end: it still shows a block.
  const first = await blocksWhileWorking(s);
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

  // A wake taken during the turn is delivered once it has ended: assumed, since the
  // reference says only that an asyncRewake exit 2 "wakes Claude immediately even when the session is idle".
  if (timing !== "none" && block === null) {
    if (await until(() => has(s, "SLACK: msg").length > 0, 6_000)) {
      block = await wokenTurn(s, has(s, "SLACK: msg")[0].text);
    }
  }
  // After Esc the first hook is the idle prompt, "about 60 seconds after Claude finishes
  // responding": the sim sends it at once.
  if (end === "interrupt") await s.fire("Notification", { notification_type: "idle_prompt", message: "Claude is waiting for your input" });
  await s.settle();
  const ticking = s.ticking();

  await s.send("ping");
  const reachable = await until(() => has(s, "SLACK: ping").length > 0, 8_000);

  const seen = timing === "none" ? null : has(s, "SLACK: msg").length;
  const when = timing === "none" ? null
    : has(s, "SLACK: msg").some((d) => d.how === "in-turn") ? "in-turn"
      : seen > 0 ? "after the turn" : "never";
  return { seen, when, first, block, ticking, reachable };
}

export const CELLS = STARTS.flatMap((start) => ENDS.flatMap((end) => TIMINGS.map((timing) => ({ start, end, timing }))));
export const cellName = ({ start, end, timing }) => `${start} · message ${timing} · ends ${end}`;
