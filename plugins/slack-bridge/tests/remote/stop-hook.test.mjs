// Stop / PostToolUse hook: re-arm nudge + live mirror of the turn's text. A
// fake broker client, a tmp stateDir and a fixture transcript — no network.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runHook, shortArg } from "../../src/remote/stop-hook.mjs";
import { createBrokerClient } from "../../src/remote/broker-client.mjs";
import { waitCommand, BASH_TIMEOUT_MS } from "../../src/remote/wait-constants.mjs";

const SID = "sess-1";
const PEER = "peer-a";

function fakeClient({ armed = [false], peerRow = true, sendDelay = null, fail = false } = {}) {
  const sends = [];
  let listCalls = 0;
  return {
    sends,
    get listCalls() { return listCalls; },
    async listPeers() {
      if (fail) throw new Error("fetch failed");
      const a = armed[Math.min(listCalls, armed.length - 1)];
      listCalls++;
      return peerRow ? [{ id: PEER, armed: a }, { id: "other", armed: true }] : [{ id: "other", armed: true }];
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

function hook(env, client, { event = "Stop", active = false, tool, sleeps, loads, createOpts, raw } = {}) {
  const input = { session_id: SID, transcript_path: env.transcript, hook_event_name: event, stop_hook_active: active };
  if (tool) Object.assign(input, { tool_name: tool.name, tool_input: tool.input });
  return runHook({
    raw: raw ?? JSON.stringify(input),
    stateDir: env.stateDir,
    _loadConfig: ({ configPath }) => { loads?.push(configPath); return { remote: { brokerPort: 1, controlToken: "tok" } }; },
    _createClient: (opts) => { createOpts?.push(opts); return client; },
    _sleep: async (ms) => { sleeps?.push(ms); },
  });
}

// First hook after a seize: starts the cursor at the newest entry, sends nothing.
async function prime(env) {
  env.append(userEntry("u0", "pre-seize prompt"), textEntry("a0", "PRE-SEIZE TEXT"));
  await hook(env, fakeClient({ armed: [true] }), { event: "PostToolUse", tool: { name: "mcp__slack__slack_seize", input: {} } });
}

const textSends = (c) => c.sends.filter((s) => s.kind === "text");

// --- re-arm decision ---

test("claim held + not armed → block whose reason carries the waitCommand", async (t) => {
  const env = setup(t);
  const out = await hook(env, fakeClient({ armed: [false] }));
  assert.equal(out?.decision, "block");
  assert.ok(out.reason.includes(waitCommand(PEER, { configPath: env.configPath })), out.reason);
  assert.ok(out.reason.includes(String(BASH_TIMEOUT_MS)));
  assert.match(out.reason, /#rc-test/);
});

test("claim held + armed → allow", async (t) => {
  const env = setup(t);
  assert.equal(await hook(env, fakeClient({ armed: [true] })), null);
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
  const seen = [];
  const _fetch = async (url, init) => {
    seen.push({ url, auth: init.headers?.Authorization });
    return new Response(JSON.stringify([{ id: PEER, armed: true }]), { status: 200 });
  };
  const out = await runHook({
    raw: JSON.stringify({ session_id: SID, transcript_path: env.transcript, hook_event_name: "Stop" }),
    stateDir: env.stateDir,
    _createClient: (opts) => createBrokerClient({ ...opts, _fetch }),
    _sleep: async () => {},
  });
  assert.equal(out, null);
  const list = seen.find((s) => s.url.endsWith("/list-peers"));
  assert.ok(list, JSON.stringify(seen));
  assert.equal(list.auth, "Bearer custom-token");
  assert.match(list.url, /:45678\//);
});

test("not armed at first, armed on the 2nd re-check → allow (A3)", async (t) => {
  const env = setup(t);
  const sleeps = [];
  const client = fakeClient({ armed: [false, false, true] });
  assert.equal(await hook(env, client, { sleeps }), null);
  assert.equal(client.listCalls, 3);
  assert.deepEqual(sleeps, [500, 500]);
});

test("never armed → re-checks every 500 ms for 3 s, then blocks (A3)", async (t) => {
  const env = setup(t);
  const sleeps = [];
  const client = fakeClient({ armed: [false] });
  const out = await hook(env, client, { sleeps });
  assert.equal(out?.decision, "block");
  assert.equal(client.listCalls, 7);
  assert.equal(sleeps.reduce((a, b) => a + b, 0), 3000);
});

test("peer row gone from the broker → allow (the claim is dead, the command would be wrong)", async (t) => {
  const env = setup(t);
  assert.equal(await hook(env, fakeClient({ peerRow: false })), null);
});

test("stop_hook_active → allow, AND new turn text after the cursor is still mirrored (B1)", async (t) => {
  const env = setup(t);
  await prime(env);
  env.append(textEntry("a1", "retried stop text"));
  const client = fakeClient({ armed: [false] });
  const out = await hook(env, client, { active: true });
  assert.equal(out, null);
  assert.equal(client.listCalls, 0, "no re-arm check on the second stop");
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
  const client = fakeClient({ armed: [true] });
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
  const c1 = fakeClient({ armed: [true] });
  await hook(env, c1);
  const c2 = fakeClient({ armed: [true] });
  await hook(env, c2);
  assert.equal(textSends(c1).length, 1);
  assert.equal(textSends(c2).length, 0);
});

test("mirror: no claim → no send", async (t) => {
  const env = setup(t, { claimed: false });
  env.append(textEntry("a1", "unclaimed"));
  const client = fakeClient({ armed: [true] });
  await hook(env, client);
  assert.equal(client.sends.length, 0);
  assert.ok(!fs.existsSync(env.cursorFile));
});

test("mirror: first stop after seize sends nothing from before the seize", async (t) => {
  const env = setup(t);
  env.append(userEntry("u0", "hi"), textEntry("a0", "PRE-SEIZE TEXT"));
  const client = fakeClient({ armed: [true] });
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
  const client = fakeClient({ armed: [true] });
  await hook(env, client);
  assert.equal(textSends(client).length, 0);
  assert.equal(env.cursor(), "a1");
});

test("mirror sends even when the same stop also blocks for re-arm", async (t) => {
  const env = setup(t);
  await prime(env);
  env.append(textEntry("a1", "reply text"));
  const client = fakeClient({ armed: [false] });
  const out = await hook(env, client);
  assert.equal(out?.decision, "block");
  assert.deepEqual(textSends(client).map((s) => s.text), ["reply text"]);
});

test("PostToolUse: new narration is sent before the turn ends, then a status message carries tool + arg", async (t) => {
  const env = setup(t);
  await prime(env);
  env.append(textEntry("a1", "running the tests now"), toolEntry("a2", "Bash", { command: "npm test" }));
  const client = fakeClient({ armed: [false] });
  const out = await hook(env, client, { event: "PostToolUse", tool: { name: "Bash", input: { command: "npm test", description: "Run tests" } } });
  assert.equal(out, null);
  assert.deepEqual(client.sends.map((s) => [s.kind, s.text]), [
    ["text", "running the tests now"],
    ["status", "Bash: npm test"],
  ]);
  assert.equal(client.listCalls, 0, "PostToolUse never checks armed");
});

test("PostToolUse never returns a block decision, even unarmed with nothing to mirror", async (t) => {
  const env = setup(t);
  await prime(env);
  for (const armed of [[false], [true]]) {
    const out = await hook(env, fakeClient({ armed }), { event: "PostToolUse", tool: { name: "Read", input: { file_path: "/a/b.txt" } } });
    assert.equal(out, null);
  }
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
  const client = fakeClient({ armed: [true], sendDelay: () => gate });
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
  const client = fakeClient({ armed: [true] });
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
  const client = fakeClient({ armed: [true] });
  await hook(env, client, { event: "PostToolUse", tool: { name: "Bash", input: { command: "ls" } } });
  assert.deepEqual(textSends(client).map((s) => s.text), ["after stale lock"]);
  assert.equal(env.cursor(), "a1");
  assert.ok(!fs.existsSync(lock), "lock released after the op");
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
  const client = fakeClient({ armed: [true] });
  const out = await hook(env, client, { event: "PreToolUse", tool: { name: "AskUserQuestion", input: QUESTION } });
  assert.equal(out, null, "the hook never blocks or rewrites the question");
  const questions = client.sends.filter((s) => s.kind === "question");
  assert.equal(questions.length, 1, `one question message, got ${JSON.stringify(client.sends)}`);
  const text = questions[0].text;
  for (const needle of ["Which branch should the fix land on?", "followups", "the open followups branch", "new branch", "cut a fresh one"]) {
    assert.ok(text.includes(needle), `question message must carry "${needle}": ${text}`);
  }
});

test("PreToolUse for any other tool → nothing sent", async (t) => {
  const env = setup(t);
  await prime(env);
  const client = fakeClient({ armed: [true] });
  await hook(env, client, { event: "PreToolUse", tool: { name: "Bash", input: { command: "ls" } } });
  assert.equal(client.sends.length, 0);
});
