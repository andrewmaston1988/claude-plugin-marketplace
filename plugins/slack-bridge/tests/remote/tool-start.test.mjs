// PreToolUse with --tool-start: the text before a tool reaches Slack before the
// tool runs, then a status names what is running.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { fakeClient, hook, prime, setup, textEntry, toolEntry } from "./stop-hook-harness.mjs";

const BASH = { name: "Bash", input: { command: "npm test" }, id: "ta2" };
const sent = (client) => client.sends.map((s) => [s.kind, s.text]);

function fakeClock() {
  let at = 1_000;
  const naps = [];
  return {
    naps,
    now: () => at,
    sleep: async (ms) => { naps.push(ms); at += ms; },
    elapsed: () => at - 1_000,
  };
}

test("the text before a tool goes first, then a status names the tool", async (t) => {
  const env = setup(t);
  await prime(env);
  env.append(textEntry("a1", "running the tests now"), toolEntry("a2", "Bash", BASH.input));
  const client = fakeClient();
  const out = await hook(env, client, { event: "PreToolUse", toolStart: true, tool: BASH });
  assert.equal(out, null);
  assert.deepEqual(sent(client), [
    ["text", "running the tests now"],
    ["status", "Bash: npm test"],
  ]);
});

test("the hook polls until the tool's own entry shows, so unflushed text still goes first", async (t) => {
  const env = setup(t);
  await prime(env);
  const clock = fakeClock();
  const client = fakeClient();
  const sleep = async (ms) => {
    await clock.sleep(ms);
    if (clock.naps.length === 2) env.append(textEntry("a1", "flushed late"), toolEntry("a2", "Bash", BASH.input));
  };
  await hook(env, client, { event: "PreToolUse", toolStart: true, tool: BASH, sleep, now: clock.now });
  assert.deepEqual(sent(client), [["text", "flushed late"], ["status", "Bash: npm test"]]);
  assert.equal(clock.naps.length, 2, "polling stops once the tool's entry shows");
});

test("text for an older tool does not stop the poll", async (t) => {
  const env = setup(t);
  await prime(env);
  env.append(toolEntry("older", "Read", {}));
  const clock = fakeClock();
  const client = fakeClient();
  const sleep = async (ms) => {
    await clock.sleep(ms);
    if (clock.naps.length === 1) env.append(textEntry("a1", "mine"), toolEntry("a2", "Bash", BASH.input));
  };
  await hook(env, client, { event: "PreToolUse", toolStart: true, tool: BASH, sleep, now: clock.now });
  assert.deepEqual(sent(client), [["text", "mine"], ["status", "Bash: npm test"]]);
});

test("an entry that never shows still gets its status, at 2 seconds", async (t) => {
  const env = setup(t);
  await prime(env);
  const clock = fakeClock();
  const client = fakeClient();
  await hook(env, client, { event: "PreToolUse", toolStart: true, tool: BASH, sleep: clock.sleep, now: clock.now });
  assert.deepEqual(sent(client), [["status", "Bash: npm test"]]);
  assert.equal(clock.elapsed(), 2_000);
});

test("a held lock sends no text, and the status still goes out", async (t) => {
  const env = setup(t);
  await prime(env);
  env.append(textEntry("a1", "held back"), toolEntry("a2", "Bash", BASH.input));
  fs.writeFileSync(env.cursorFile + ".lock", "");
  const clock = fakeClock();
  const client = fakeClient();
  await hook(env, client, { event: "PreToolUse", toolStart: true, tool: BASH, sleep: clock.sleep, now: clock.now });
  assert.deepEqual(sent(client), [["status", "Bash: npm test"]]);
  assert.equal(env.cursor(), "a0");
});

test("a broken mirror still sends the status", async (t) => {
  const env = setup(t);
  await prime(env);
  fs.rmSync(env.transcript);
  const clock = fakeClock();
  const client = fakeClient();
  await hook(env, client, { event: "PreToolUse", toolStart: true, tool: BASH, sleep: clock.sleep, now: clock.now });
  assert.deepEqual(sent(client), [["status", "Bash: npm test"]]);
});

test("a tool with no salient argument sends its bare name", async (t) => {
  const env = setup(t);
  await prime(env);
  env.append(toolEntry("a2", "TodoWrite", {}));
  const client = fakeClient();
  await hook(env, client, { event: "PreToolUse", toolStart: true, tool: { name: "TodoWrite", input: {}, id: "ta2" } });
  assert.deepEqual(sent(client), [["status", "TodoWrite"]]);
});

test("AskUserQuestion is left to the synchronous entry: nothing sent, cursor untouched", async (t) => {
  const env = setup(t);
  await prime(env);
  env.append(textEntry("a1", "about to ask"));
  const client = fakeClient();
  const out = await hook(env, client, { event: "PreToolUse", toolStart: true, tool: { name: "AskUserQuestion", input: { questions: [] }, id: "ta2" } });
  assert.equal(out, null, "the async entry cannot deny, so it must not try");
  assert.deepEqual(client.sends, []);
  assert.equal(env.cursor(), "a0");
});

test("an unclaimed session sends nothing and loads no config", async (t) => {
  const env = setup(t, { claimed: false });
  const client = fakeClient();
  const loads = [];
  assert.equal(await hook(env, client, { event: "PreToolUse", toolStart: true, tool: BASH, loads }), null);
  assert.deepEqual(client.sends, []);
  assert.deepEqual(loads, []);
});

test("PostToolUse mirrors text but sends no status: the status belongs to the tool's start", async (t) => {
  const env = setup(t);
  await prime(env);
  env.append(textEntry("a1", "that passed"));
  const client = fakeClient();
  await hook(env, client, { event: "PostToolUse", tool: BASH });
  assert.deepEqual(sent(client), [["text", "that passed"]]);
});

test("hooks.json runs stop-hook --tool-start on every tool, async, beside the sync question entry", () => {
  const file = fileURLToPath(new URL("../../hooks/hooks.json", import.meta.url));
  const groups = JSON.parse(fs.readFileSync(file, "utf8")).hooks.PreToolUse;
  const every = groups.filter((g) => g.matcher === "*").flatMap((g) => g.hooks);
  const start = every.filter((h) => /claude-slack\.mjs" stop-hook --tool-start$/.test(h.command ?? ""));
  assert.equal(start.length, 1, JSON.stringify(every));
  assert.equal(start[0].async, true, "a tool must not wait on the mirror");

  const ask = groups.filter((g) => g.matcher === "AskUserQuestion").flatMap((g) => g.hooks);
  assert.equal(ask.length, 1, JSON.stringify(ask));
  assert.match(ask[0].command, /claude-slack\.mjs" stop-hook$/);
  assert.equal(ask[0].async, false, "a deny only counts from a synchronous hook");
});
