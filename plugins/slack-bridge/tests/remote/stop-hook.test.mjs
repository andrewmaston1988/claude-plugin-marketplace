// Stop / PostToolUse hook: live mirror of the turn's text, question deny. A
// fake broker client, a tmp stateDir and a fixture transcript — no network.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runHook, shortArg, formatQuestion } from "../../src/remote/stop-hook.mjs";
import { mdToSlack } from "../../src/markdown/index.mjs";
import { createBrokerClient } from "../../src/remote/broker-client.mjs";
import { PRIMING_LINE } from "../../src/remote/waiter.mjs";

const SID = "sess-1";
const PEER = "peer-a";

function fakeClient({ sendDelay = null, fail = false } = {}) {
  const sends = [];
  let listCalls = 0;
  return {
    sends,
    get listCalls() { return listCalls; },
    // Stop never asks the broker whether a waiter is armed: the asyncRewake hook
    // owns the waiter, so any listPeers call is a regression, not a reading.
    async listPeers() {
      listCalls++;
      throw new Error("Stop must never call listPeers");
    },
    async sendMessage(from, to, text, opts = {}) {
      if (fail) throw new Error("fetch failed");
      if (sendDelay) await sendDelay();
      sends.push({ from, to, text, kind: opts.kind ?? "text" });
      return { ok: true };
    },
  };
}

const textEntry = (uuid, text) => ({ type: "assistant", uuid, message: { role: "assistant", content: [{ type: "text", text }] } });
const toolEntry = (uuid, name, input) => ({ type: "assistant", uuid, message: { role: "assistant", content: [{ type: "tool_use", id: "t" + uuid, name, input }] } });
const thinkEntry = (uuid) => ({ type: "assistant", uuid, message: { role: "assistant", content: [{ type: "thinking", thinking: "SECRET THOUGHT" }] } });
const userEntry = (uuid, text) => ({ type: "user", uuid, message: { role: "user", content: text } });

function setup(t, { claimed = true, configPath } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "stophook-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const stateDir = path.join(dir, "state");
  const transcript = path.join(dir, "t.jsonl");
  const cfg = configPath ?? path.join(dir, "custom-config.json");
  fs.writeFileSync(transcript, "");
  if (claimed) {
    fs.mkdirSync(path.join(stateDir, "remote-sessions"), { recursive: true });
    fs.writeFileSync(path.join(stateDir, "remote-sessions", `${SID}.json`), JSON.stringify({ peerId: PEER, configPath: cfg, channel: "rc-test" }));
  }
  const append = (...entries) => fs.appendFileSync(transcript, entries.map((e) => JSON.stringify(e) + "\n").join(""));
  const cursorFile = path.join(stateDir, "mirror", `${SID}.json`);
  const cursor = () => (fs.existsSync(cursorFile) ? JSON.parse(fs.readFileSync(cursorFile, "utf8")).uuid : null);
  return { dir, stateDir, transcript, configPath: cfg, append, cursorFile, cursor };
}

function hook(env, client, { event = "Stop", active = false, tool, sleeps, sleep, now, loads, createOpts, raw, prompt, lastMessage } = {}) {
  const input = { session_id: SID, transcript_path: env.transcript, hook_event_name: event, stop_hook_active: active };
  if (tool) Object.assign(input, { tool_name: tool.name, tool_input: tool.input });
  if (prompt !== undefined) input.prompt = prompt;
  if (lastMessage !== undefined) input.last_assistant_message = lastMessage;
  return runHook({
    raw: raw ?? JSON.stringify(input),
    stateDir: env.stateDir,
    _loadConfig: ({ configPath }) => { loads?.push(configPath); return { remote: { brokerPort: 1, controlToken: "tok" } }; },
    _createClient: (opts) => { createOpts?.push(opts); return client; },
    _sleep: sleep ?? (async (ms) => { sleeps?.push(ms); }),
    _now: now,
  });
}

// First hook after a seize: starts the cursor at the newest entry, sends nothing.
async function prime(env) {
  env.append(userEntry("u0", "pre-seize prompt"), textEntry("a0", "PRE-SEIZE TEXT"));
  await hook(env, fakeClient(), { event: "PostToolUse", tool: { name: "mcp__slack__slack_seize", input: {} } });
}

const textSends = (c) => c.sends.filter((s) => s.kind === "text");

// --- no re-arm decision: the asyncRewake hook owns the waiter ---

test("Stop never returns a block, claimed or not, and never asks the broker about a waiter", async (t) => {
  for (const claimed of [true, false]) {
    const env = setup(t, { claimed });
    const client = fakeClient();
    assert.equal(await hook(env, client), null, `claimed=${claimed}`);
    assert.equal(await hook(env, client, { active: true }), null, `retried stop, claimed=${claimed}`);
    assert.equal(client.listCalls, 0, "Stop never asks the broker whether a waiter is armed");
  }
});

test("unknown session_id (no remote-sessions file) → allow, no config load, no broker client (A4)", async (t) => {
  const env = setup(t, { claimed: false });
  const loads = [], createOpts = [];
  const out = await hook(env, fakeClient(), { loads, createOpts });
  assert.equal(out, null);
  assert.deepEqual(loads, []);
  assert.deepEqual(createOpts, []);
});

test("a path-like session_id never escapes the state dir → allow, no broker client", async (t) => {
  const env = setup(t);
  const createOpts = [];
  const raw = JSON.stringify({ session_id: "../remote-sessions/" + SID, hook_event_name: "Stop", transcript_path: env.transcript });
  assert.equal(await hook(env, fakeClient(), { raw, createOpts }), null);
  assert.deepEqual(createOpts, []);
});

test("non-default configPath in the remote-sessions file → hook authenticates with THAT config's token (A4)", async (t) => {
  const env = setup(t);
  fs.writeFileSync(env.configPath, JSON.stringify({
    tokens: { bot: "xoxb", app: "xapp" }, claude: { cwd: "." },
    remote: { brokerPort: 45678, controlToken: "custom-token" },
  }));
  await prime(env);
  env.append(textEntry("a1", "authed text"));
  const seen = [];
  const _fetch = async (url, init) => {
    seen.push({ url, auth: init.headers?.Authorization });
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  };
  const out = await runHook({
    raw: JSON.stringify({ session_id: SID, transcript_path: env.transcript, hook_event_name: "Stop" }),
    stateDir: env.stateDir,
    _createClient: (opts) => createBrokerClient({ ...opts, _fetch }),
    _sleep: async () => {},
  });
  assert.equal(out, null);
  const send = seen.find((s) => s.url.endsWith("/send-message"));
  assert.ok(send, JSON.stringify(seen));
  assert.equal(send.auth, "Bearer custom-token");
  assert.match(send.url, /:45678\//);
});

test("stop_hook_active → that turn's text is still mirrored (B1)", async (t) => {
  const env = setup(t);
  await prime(env);
  env.append(textEntry("a1", "retried stop text"));
  const client = fakeClient();
  assert.equal(await hook(env, client, { active: true }), null);
  assert.deepEqual(textSends(client).map((s) => s.text), ["retried stop text"]);
});

test("broker unreachable → allow, never throws", async (t) => {
  const env = setup(t);
  await prime(env);
  env.append(textEntry("a1", "x"));
  assert.equal(await hook(env, fakeClient({ fail: true })), null);
});

test("malformed stdin → allow, never throws", async (t) => {
  const env = setup(t);
  assert.equal(await hook(env, fakeClient(), { raw: "{not json" }), null);
  assert.equal(await hook(env, fakeClient(), { raw: "" }), null);
});

test("config load throws → allow", async (t) => {
  const env = setup(t);
  const out = await runHook({
    raw: JSON.stringify({ session_id: SID, transcript_path: env.transcript, hook_event_name: "Stop" }),
    stateDir: env.stateDir,
    _loadConfig: () => { throw new Error("Config file not found"); },
    _sleep: async () => {},
  });
  assert.equal(out, null);
});

// --- mirror ---

test("mirror: two text blocks + a tool_use + thinking after the cursor → ONE send with both texts, cursor advances", async (t) => {
  const env = setup(t);
  await prime(env);
  assert.equal(env.cursor(), "a0");
  env.append(textEntry("a1", "first narration"), toolEntry("a2", "Bash", { command: "SECRET_TOOL_INPUT" }), thinkEntry("a3"), textEntry("a4", "second narration"));
  const client = fakeClient();
  await hook(env, client);
  const texts = textSends(client);
  assert.equal(texts.length, 1);
  assert.equal(texts[0].from, PEER);
  assert.equal(texts[0].to, "slack-bridge");
  assert.match(texts[0].text, /first narration[\s\S]*second narration/);
  assert.ok(!/SECRET/.test(texts[0].text), texts[0].text);
  assert.equal(env.cursor(), "a4");
});

test("mirror: second stop with no new entries → no send", async (t) => {
  const env = setup(t);
  await prime(env);
  env.append(textEntry("a1", "once"));
  const c1 = fakeClient();
  await hook(env, c1);
  const c2 = fakeClient();
  await hook(env, c2);
  assert.equal(textSends(c1).length, 1);
  assert.equal(textSends(c2).length, 0);
});

// --- offset tail: only the appended region is read ---

const readCursorFile = (env) => JSON.parse(fs.readFileSync(env.cursorFile, "utf8"));
const writeCursorFile = (env, patch) => fs.writeFileSync(env.cursorFile, JSON.stringify({ ...readCursorFile(env), ...patch }));

test("mirror: the cursor records the byte offset it has read up to", async (t) => {
  const env = setup(t);
  await prime(env);
  assert.equal(readCursorFile(env).offset, fs.statSync(env.transcript).size);
});

test("mirror: bytes before the stored offset are never re-read", async (t) => {
  const env = setup(t);
  await prime(env);
  // Mark a1 as already read by offset while the uuid cursor still sits at a0:
  // a whole-file reader would re-send it, an offset reader cannot see it.
  env.append(textEntry("a1", "ALREADY READ"));
  writeCursorFile(env, { offset: fs.statSync(env.transcript).size });
  env.append(textEntry("a2", "fresh"));
  const client = fakeClient();
  await hook(env, client);
  assert.deepEqual(textSends(client).map((s) => s.text), ["fresh"]);
  assert.equal(env.cursor(), "a2");
});

test("mirror: a half-written last line is left for the next read, then sent once", async (t) => {
  const env = setup(t);
  await prime(env);
  const line = JSON.stringify(textEntry("a2", "second"));
  env.append(textEntry("a1", "first"));
  fs.appendFileSync(env.transcript, line.slice(0, 20));
  const c1 = fakeClient();
  await hook(env, c1);
  fs.appendFileSync(env.transcript, line.slice(20) + "\n");
  const c2 = fakeClient();
  await hook(env, c2);
  assert.deepEqual(textSends(c1).map((s) => s.text), ["first"]);
  assert.deepEqual(textSends(c2).map((s) => s.text), ["second"]);
});

test("mirror: a transcript rewritten under the offset falls back to the uuid cursor", async (t) => {
  const env = setup(t);
  await prime(env);
  env.append(textEntry("a1", "x".repeat(400)));
  await hook(env, fakeClient());
  // Shorter rewrite (offset now past EOF), then a longer one (offset mid-line).
  for (const [uuid, text] of [["a2", "after short rewrite"], ["a3", "after long rewrite"]]) {
    const body = [textEntry("a1", "x"), textEntry(uuid, text)];
    if (uuid === "a3") body.unshift(userEntry("pad", "p".repeat(2000)));
    fs.writeFileSync(env.transcript, body.map((e) => JSON.stringify(e) + "\n").join(""));
    writeCursorFile(env, { uuid: "a1" });
    const client = fakeClient();
    await hook(env, client);
    assert.deepEqual(textSends(client).map((s) => s.text), [text]);
  }
});

test("mirror: no claim → no send", async (t) => {
  const env = setup(t, { claimed: false });
  env.append(textEntry("a1", "unclaimed"));
  const client = fakeClient();
  await hook(env, client);
  assert.equal(client.sends.length, 0);
  assert.ok(!fs.existsSync(env.cursorFile));
});

test("mirror: first stop after seize sends nothing from before the seize", async (t) => {
  const env = setup(t);
  env.append(userEntry("u0", "hi"), textEntry("a0", "PRE-SEIZE TEXT"));
  const client = fakeClient();
  await hook(env, client);
  assert.equal(textSends(client).length, 0);
  assert.equal(env.cursor(), "a0");
});

test("mirror: a re-seize (remote-sessions file rewritten) restarts the cursor — no backfill of the gap", async (t) => {
  const env = setup(t);
  await prime(env);
  env.append(textEntry("a1", "between seizes"));
  // Unseize + re-seize: the server rewrites the file; its mtime moves.
  const f = path.join(env.stateDir, "remote-sessions", `${SID}.json`);
  const later = new Date(Date.now() + 5000);
  fs.utimesSync(f, later, later);
  const client = fakeClient();
  await hook(env, client);
  assert.equal(textSends(client).length, 0);
  assert.equal(env.cursor(), "a1");
});

test("mirror sends on a Stop with no waiter armed", async (t) => {
  const env = setup(t);
  await prime(env);
  env.append(textEntry("a1", "reply text"));
  const client = fakeClient();
  const out = await hook(env, client);
  assert.equal(out, null);
  assert.deepEqual(textSends(client).map((s) => s.text), ["reply text"]);
});

test("PostToolUse: new narration is sent before the turn ends, then a status message carries tool + arg", async (t) => {
  const env = setup(t);
  await prime(env);
  env.append(textEntry("a1", "running the tests now"), toolEntry("a2", "Bash", { command: "npm test" }));
  const client = fakeClient();
  const out = await hook(env, client, { event: "PostToolUse", tool: { name: "Bash", input: { command: "npm test", description: "Run tests" } } });
  assert.equal(out, null);
  assert.deepEqual(client.sends.map((s) => [s.kind, s.text]), [
    ["text", "running the tests now"],
    ["status", "Bash: npm test"],
  ]);
  assert.equal(client.listCalls, 0, "PostToolUse never checks armed");
});

test("PostToolUse never returns a block decision", async (t) => {
  const env = setup(t);
  await prime(env);
  const out = await hook(env, fakeClient(), { event: "PostToolUse", tool: { name: "Read", input: { file_path: "/a/b.txt" } } });
  assert.equal(out, null);
});

test("shortArg picks the salient field, one line, truncated", () => {
  assert.equal(shortArg({ command: "npm  test\n  --watch" }), "npm test --watch");
  assert.equal(shortArg({ file_path: "/x/y.mjs", old_string: "aaa" }), "/x/y.mjs");
  assert.equal(shortArg({ pattern: "foo.*bar", path: "src" }), "foo.*bar");
  assert.equal(shortArg({}), "");
  assert.equal(shortArg(undefined), "");
  const long = shortArg({ command: "x".repeat(300) });
  assert.ok(long.length <= 80, String(long.length));
  assert.ok(long.endsWith("…"));
});

// --- B2: mirror concurrency ---

test("two overlapping mirror invocations → each text sent exactly once, cursor ends at the newest uuid (B2)", async (t) => {
  const env = setup(t);
  await prime(env);
  env.append(textEntry("a1", "block one"));
  let release;
  const gate = new Promise((r) => { release = r; });
  const client = fakeClient({ sendDelay: () => gate });
  const tool = { name: "Bash", input: { command: "ls" } };
  const first = hook(env, client, { event: "PostToolUse", tool });
  await new Promise((r) => setTimeout(r, 20)); // first now holds the lock, parked in sendMessage
  env.append(textEntry("a2", "block two"));
  const second = hook(env, client, { event: "PostToolUse", tool });
  await new Promise((r) => setTimeout(r, 20));
  release();
  await Promise.all([first, second]);
  // The contender left its text after the un-advanced cursor; the next hook picks it up.
  await hook(env, client, { event: "PostToolUse", tool });
  const counts = {};
  for (const s of textSends(client)) for (const piece of s.text.split("\n\n")) counts[piece] = (counts[piece] ?? 0) + 1;
  assert.deepEqual(counts, { "block one": 1, "block two": 1 }, JSON.stringify(textSends(client)));
  assert.equal(env.cursor(), "a2");
});

test("a fresh lock makes the contender exit without sending; cursor untouched (B2)", async (t) => {
  const env = setup(t);
  await prime(env);
  env.append(textEntry("a1", "held back"));
  fs.writeFileSync(env.cursorFile + ".lock", "");
  const client = fakeClient();
  await hook(env, client, { event: "PostToolUse", tool: { name: "Bash", input: { command: "ls" } } });
  assert.equal(textSends(client).length, 0);
  assert.equal(env.cursor(), "a0");
  assert.ok(fs.existsSync(env.cursorFile + ".lock"), "someone else's lock is left alone");
});

test("a lock older than 10 s is stale and broken (B2)", async (t) => {
  const env = setup(t);
  await prime(env);
  env.append(textEntry("a1", "after stale lock"));
  const lock = env.cursorFile + ".lock";
  fs.writeFileSync(lock, "");
  const old = new Date(Date.now() - 11_000);
  fs.utimesSync(lock, old, old);
  const client = fakeClient();
  await hook(env, client, { event: "PostToolUse", tool: { name: "Bash", input: { command: "ls" } } });
  assert.deepEqual(textSends(client).map((s) => s.text), ["after stale lock"]);
  assert.equal(env.cursor(), "a1");
  assert.ok(!fs.existsSync(lock), "lock released after the op");
});

// --- the other half of the conversation: prompts typed at the terminal ---
// The transcript cannot supply these — a wake is a `user` row there, so reading
// those rows would post the operator's own Slack text back into Slack.

test("UserPromptSubmit on a claimed session sends the typed prompt as kind:prompt", async (t) => {
  const env = setup(t);
  await prime(env);
  const client = fakeClient();
  assert.equal(await hook(env, client, { event: "UserPromptSubmit", prompt: "run the tests again" }), null);
  assert.deepEqual(client.sends.map((s) => [s.kind, s.text]), [["prompt", "run the tests again"]]);
});

test("UserPromptSubmit on an unclaimed session sends nothing", async (t) => {
  const env = setup(t, { claimed: false });
  const client = fakeClient();
  assert.equal(await hook(env, client, { event: "UserPromptSubmit", prompt: "typed in a normal session" }), null);
  assert.equal(client.sends.length, 0);
});

test("a rewake prompt starting <task-notification> sends nothing, with or without the priming line", async (t) => {
  const env = setup(t);
  await prime(env);
  const client = fakeClient();
  for (const prompt of [
    `<task-notification>\n<task-id>x</task-id>\n</task-notification>`,
    `<task-notification>\nSLACK: hello\n${PRIMING_LINE}`,
  ]) {
    await hook(env, client, { event: "UserPromptSubmit", prompt });
  }
  assert.equal(client.sends.length, 0, JSON.stringify(client.sends));
});

test("a prompt carrying the priming line sends nothing — the operator's Slack text is not echoed back", async (t) => {
  const env = setup(t);
  await prime(env);
  const client = fakeClient();
  await hook(env, client, { event: "UserPromptSubmit", prompt: `SLACK: what is the status\n${PRIMING_LINE}` });
  assert.equal(client.sends.length, 0);
});

test("an empty prompt sends nothing", async (t) => {
  const env = setup(t);
  await prime(env);
  const client = fakeClient();
  await hook(env, client, { event: "UserPromptSubmit", prompt: "   " });
  assert.equal(client.sends.length, 0);
});

test("Stop sends kind:turn-end after the mirror, so the terminal block closes", async (t) => {
  const env = setup(t);
  await prime(env);
  env.append(textEntry("a1", "the answer"));
  const client = fakeClient();
  await hook(env, client);
  assert.deepEqual(client.sends.map((s) => s.kind), ["text", "turn-end"], JSON.stringify(client.sends));
  assert.equal(client.sends[1].to, "slack-bridge");
});

test("Stop still sends turn-end when there was no new text", async (t) => {
  const env = setup(t);
  await prime(env);
  const client = fakeClient();
  await hook(env, client);
  assert.deepEqual(client.sends.map((s) => s.kind), ["turn-end"]);
});

// --- Stop waits for the turn's reply to reach the transcript ---
// The CLI fires Stop before flushing the turn's last entry, so a mirror at
// hook start finds nothing and turn-end would close the block with the reply
// unread. A fake clock keeps the 100ms poll and the 3s bound instant.

function fakeClock() {
  const clock = { t: 1000, sleeps: [] };
  clock.now = () => clock.t;
  clock.sleep = async (ms) => { clock.sleeps.push(ms); clock.t += ms; };
  return clock;
}

test("Stop: a reply flushed after the hook starts is mirrored before turn-end", async (t) => {
  const env = setup(t);
  await prime(env);
  const clock = fakeClock();
  const client = fakeClient();
  await hook(env, client, {
    lastMessage: "the flushed answer",
    now: clock.now,
    sleep: async (ms) => {
      clock.sleeps.push(ms);
      clock.t += ms;
      env.append(textEntry("a1", "the flushed answer"));
    },
  });
  assert.deepEqual(client.sends.map((s) => s.kind), ["text", "turn-end"], JSON.stringify(client.sends));
  assert.equal(client.sends[0].text, "the flushed answer");
  assert.deepEqual(clock.sleeps, [100], "one 100ms retry after the flush landed");
});

test("Stop: at the 3s bound turn-end still goes, and the next hook sends the text once", async (t) => {
  const env = setup(t);
  await prime(env);
  const clock = fakeClock();
  const client = fakeClient();
  await hook(env, client, { lastMessage: "never flushed in time", now: clock.now, sleep: clock.sleep });
  assert.deepEqual(client.sends.map((s) => s.kind), ["turn-end"], JSON.stringify(client.sends));
  assert.equal(clock.sleeps.length, 30, JSON.stringify(clock.sleeps));
  assert.ok(clock.sleeps.every((ms) => ms === 100), JSON.stringify(clock.sleeps));

  env.append(textEntry("a1", "never flushed in time"));
  await hook(env, client, { lastMessage: "never flushed in time", now: clock.now, sleep: clock.sleep });
  assert.deepEqual(textSends(client).map((s) => s.text), ["never flushed in time"], "the field is never posted directly");
  assert.equal(clock.sleeps.length, 30, "the next hook found the tail at once, no further wait");
});

test("Stop: a reply an earlier hook already mirrored costs no wait, and a pass with no new text keeps the tail", async (t) => {
  const env = setup(t);
  await prime(env);
  env.append(textEntry("a1", "already mirrored answer"));
  await hook(env, fakeClient(), { event: "PostToolUse", tool: { name: "Bash", input: { command: "ls" } } });
  assert.equal(readCursorFile(env).tail, "already mirrored answer");

  const clock = fakeClock();
  const client = fakeClient();
  await hook(env, client, { lastMessage: "already mirrored answer", now: clock.now, sleep: clock.sleep });
  assert.deepEqual(clock.sleeps, [], "the tail already carries the reply");
  assert.deepEqual(client.sends.map((s) => s.kind), ["turn-end"]);
  assert.equal(readCursorFile(env).tail, "already mirrored answer", "a pass with no new text keeps the tail");
});

test("Stop: an identical reply in the next turn waits, because UserPromptSubmit clears the tail", async (t) => {
  const env = setup(t);
  await prime(env);
  env.append(textEntry("a1", "same answer"));
  const first = fakeClient();
  await hook(env, first, { lastMessage: "same answer" });
  assert.deepEqual(textSends(first).map((s) => s.text), ["same answer"]);
  assert.equal(readCursorFile(env).tail, "same answer");

  await hook(env, fakeClient(), { event: "UserPromptSubmit", prompt: "do it again" });
  assert.equal(readCursorFile(env).tail, undefined, "the prompt clears the tail");

  const clock = fakeClock();
  const second = fakeClient();
  await hook(env, second, { lastMessage: "same answer", now: clock.now, sleep: clock.sleep });
  assert.equal(clock.sleeps.length, 30, "without the clear this would have returned at once");
  assert.deepEqual(second.sends.map((s) => s.kind), ["turn-end"]);
});

test("UserPromptSubmit leaves the cursor alone while another hook holds the lock", async (t) => {
  const env = setup(t);
  await prime(env);
  env.append(textEntry("a1", "held answer"));
  await hook(env, fakeClient(), { lastMessage: "held answer" });
  fs.writeFileSync(env.cursorFile + ".lock", "");

  await hook(env, fakeClient(), { event: "UserPromptSubmit", prompt: "next" });
  assert.equal(readCursorFile(env).tail, "held answer", "a clear outside the lock can write an older cursor over a newer one");
});

test("Stop: no last_assistant_message, or an empty one, means one mirror pass and no wait", async (t) => {
  for (const lastMessage of [undefined, ""]) {
    const env = setup(t);
    await prime(env);
    env.append(textEntry("a1", "reply without the field"));
    const clock = fakeClock();
    const client = fakeClient();
    await hook(env, client, { lastMessage, now: clock.now, sleep: clock.sleep });
    assert.deepEqual(clock.sleeps, [], `lastMessage=${JSON.stringify(lastMessage)}`);
    assert.deepEqual(client.sends.map((s) => s.kind), ["text", "turn-end"], JSON.stringify(client.sends));
  }
});

test("Stop: a hook locked out by another retries inside the bound, then mirrors", async (t) => {
  const env = setup(t);
  await prime(env);
  env.append(textEntry("a1", "contended answer"));
  const lock = env.cursorFile + ".lock";
  fs.writeFileSync(lock, "");
  const clock = fakeClock();
  const client = fakeClient();
  await hook(env, client, {
    lastMessage: "contended answer",
    now: clock.now,
    sleep: async (ms) => {
      clock.sleeps.push(ms);
      clock.t += ms;
      fs.unlinkSync(lock); // the other hook finishes and releases
    },
  });
  assert.deepEqual(clock.sleeps, [100], "one retry after the other hook's lock clears");
  assert.deepEqual(client.sends.map((s) => s.kind), ["text", "turn-end"], JSON.stringify(client.sends));
  assert.equal(client.sends[0].text, "contended answer");
  assert.equal(env.cursor(), "a1");
});

test("hooks.json runs stop-hook on UserPromptSubmit, async so a prompt is never held up", () => {
  const file = fileURLToPath(new URL("../../hooks/hooks.json", import.meta.url));
  const entries = (JSON.parse(fs.readFileSync(file, "utf8")).hooks.UserPromptSubmit ?? []).flatMap((g) => g.hooks);
  const mirror = entries.filter((h) => /claude-slack\.mjs" stop-hook$/.test(h.command ?? ""));
  assert.equal(mirror.length, 1, JSON.stringify(entries));
  assert.equal(mirror[0].async, true, "the mirror must not delay the prompt");
});

// --- AskUserQuestion (item 13) ---

const QUESTION = {
  questions: [{
    question: "Which branch should the fix land on?",
    header: "Branch",
    multiSelect: false,
    options: [
      { label: "followups", description: "the open followups branch" },
      { label: "new branch", description: "cut a fresh one" },
    ],
  }],
};

test("PreToolUse AskUserQuestion → the question and every option reach Slack as a question message", async (t) => {
  const env = setup(t);
  await prime(env);
  const client = fakeClient();
  const out = await hook(env, client, { event: "PreToolUse", tool: { name: "AskUserQuestion", input: QUESTION } });
  assert.equal(out?.hookSpecificOutput?.permissionDecision, "deny", "a claimed session must not open a terminal dialog");
  const questions = client.sends.filter((s) => s.kind === "question");
  assert.equal(questions.length, 1, `one question message, got ${JSON.stringify(client.sends)}`);
  const text = questions[0].text;
  for (const needle of ["Which branch should the fix land on?", "followups", "the open followups branch", "new branch", "cut a fresh one"]) {
    assert.ok(text.includes(needle), `question message must carry "${needle}": ${text}`);
  }
});

test("PreToolUse AskUserQuestion → mirrored before the deny, so the operator still sees the question", async (t) => {
  const env = setup(t);
  await prime(env);
  env.append(textEntry("a1", "about to ask"));
  const client = fakeClient();
  const out = await hook(env, client, { event: "PreToolUse", tool: { name: "AskUserQuestion", input: QUESTION } });
  assert.equal(out?.hookSpecificOutput?.hookEventName, "PreToolUse");
  assert.equal(out?.hookSpecificOutput?.permissionDecision, "deny");
  assert.match(out.hookSpecificOutput.permissionDecisionReason, /plain text/);
  assert.deepEqual(client.sends.map((s) => s.kind), ["text", "question"], "the question is mirrored before the deny");
});

test("PreToolUse AskUserQuestion with a failing Slack post → still denied (a hidden question beats a frozen turn)", async (t) => {
  const env = setup(t);
  await prime(env);
  const out = await hook(env, fakeClient({ fail: true }), { event: "PreToolUse", tool: { name: "AskUserQuestion", input: QUESTION } });
  assert.equal(out?.hookSpecificOutput?.permissionDecision, "deny");
});

test("PreToolUse AskUserQuestion on an unclaimed session → allow, the dialog opens as usual", async (t) => {
  const env = setup(t, { claimed: false });
  const client = fakeClient();
  const out = await hook(env, client, { event: "PreToolUse", tool: { name: "AskUserQuestion", input: QUESTION } });
  assert.equal(out, null);
  assert.equal(client.sends.length, 0);
});

test("PreToolUse for any other tool → nothing sent", async (t) => {
  const env = setup(t);
  await prime(env);
  const client = fakeClient();
  await hook(env, client, { event: "PreToolUse", tool: { name: "Bash", input: { command: "ls" } } });
  assert.equal(client.sends.length, 0);
});

// Every consumer posts the question through mdToSlack, so it must be markdown in.
test("formatQuestion: renders bold labels and one-spaced dashes once through mdToSlack", () => {
  const text = formatQuestion({ questions: [{ question: "Which DB?", options: [
    { label: "Postgres", description: "relational" }, { label: "Redis" },
  ] }] });
  assert.equal(mdToSlack(text), "❓ Which DB?\n• *Postgres* — relational\n• *Redis*");
});
