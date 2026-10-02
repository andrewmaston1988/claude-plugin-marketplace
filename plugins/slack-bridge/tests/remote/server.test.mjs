// The slack_seize name-derivation path: custom-title → session-derived name →
// ai-title → daemon peer-id fragment; the cwd basename is never used.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { readSessionName, readSessionAiTitle, encodeCwd, createRemoteMcpServer, INSTRUCTIONS } from "../../src/remote-mcp/server.mjs";
import { BASH_TIMEOUT_MS, waitCommand } from "../../src/remote/wait-constants.mjs";
import { createBroker } from "../../src/remote/broker.mjs";

function tmpProjectsDir() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "slack-remote-name-"));
  return path.join(root, "projects");
}

function writeSession(dir, encoded, sessionId, lines, mtimeSecondsAgo = 0) {
  const projDir = path.join(dir, encoded);
  fs.mkdirSync(projDir, { recursive: true });
  const fp = path.join(projDir, `${sessionId}.jsonl`);
  fs.writeFileSync(fp, lines.join("\n") + "\n");
  if (mtimeSecondsAgo > 0) {
    const d = new Date(Date.now() - mtimeSecondsAgo * 1000);
    fs.utimesSync(fp, d, d);
  }
  return fp;
}

test("encodeCwd rewrites backslash, forward slash, and colon to dash", () => {
  assert.equal(encodeCwd("C:\\code\\long-night"), "C--code-long-night");
  assert.equal(encodeCwd("C:/code/long-night"), "C--code-long-night");
  assert.equal(encodeCwd("/home/andrew/torrent-hub"), "-home-andrew-torrent-hub");
});

test("encodeCwd maps dots to dashes, matching the harness's per-project dir layout", () => {
  // A dotted cwd (.swarm, .worktrees) must hit the same encoded dir the harness
  // writes — leaving '.' intact silently breaks every name read on those paths.
  assert.equal(encodeCwd("C:\\work\\x\\.worktrees\\main"), "C--work-x--worktrees-main");
  assert.equal(encodeCwd("/home/a/.swarm/runs"), "-home-a--swarm-runs");
});

test("readSessionName returns the latest custom-title from the most-recently-modified JSONL", () => {
  const dir = tmpProjectsDir();
  writeSession(dir, "C--code-long-night", "old-session", [
    `{"type":"custom-title","customTitle":"Old Name","sessionId":"old-session"}`,
  ], 60);
  writeSession(dir, "C--code-long-night", "current-session", [
    `{"type":"ai-title","aiTitle":"Greeting GLM","sessionId":"current-session"}`,
    `{"type":"custom-title","customTitle":"can-you-read-this-name","sessionId":"current-session"}`,
  ], 1);
  assert.equal(readSessionName("C:\\code\\long-night", { projectsDir: dir }), "can-you-read-this-name");
});

test("readSessionName: latest custom-title wins when several are present", () => {
  const dir = tmpProjectsDir();
  writeSession(dir, "C--code-myproj", "s1", [
    `{"type":"custom-title","customTitle":"Alpha","sessionId":"s1"}`,
    `{"type":"custom-title","customTitle":"Beta","sessionId":"s1"}`,
    `{"type":"custom-title","customTitle":"Gamma","sessionId":"s1"}`,
  ]);
  assert.equal(readSessionName("C:\\code\\myproj", { projectsDir: dir }), "Gamma");
});

test("readSessionName ignores the auto ai-title (returns null when only ai-title exists)", () => {
  const dir = tmpProjectsDir();
  writeSession(dir, "C--code-auto", "s1", [
    `{"type":"ai-title","aiTitle":"Greeting GLM","sessionId":"s1"}`,
    `{"type":"message","content":"no custom title"}`,
  ]);
  // No custom-title → null (the ai-title must NOT leak through readSessionName).
  assert.equal(readSessionName("C:\\code\\auto", { projectsDir: dir }), null);
});

test("readSessionAiTitle returns the latest auto ai-title", () => {
  const dir = tmpProjectsDir();
  writeSession(dir, "C--code-long-night", "s1", [
    `{"type":"ai-title","aiTitle":"Hi GLM","sessionId":"s1"}`,
    `{"type":"ai-title","aiTitle":"Greeting GLM","sessionId":"s1"}`,
  ]);
  assert.equal(readSessionAiTitle("C:\\code\\long-night", { projectsDir: dir }), "Greeting GLM");
});

test("readSessionAiTitle returns null when no ai-title record exists", () => {
  const dir = tmpProjectsDir();
  writeSession(dir, "C--code-quiet", "s1", [
    `{"type":"custom-title","customTitle":"A Real Name","sessionId":"s1"}`,
    `{"type":"message","content":"no ai-title"}`,
  ]);
  assert.equal(readSessionAiTitle("C:\\code\\quiet", { projectsDir: dir }), null);
});

test("readSessionName / readSessionAiTitle return null when the project dir does not exist", () => {
  const dir = tmpProjectsDir();
  assert.equal(readSessionName("C:\\code\\never", { projectsDir: dir }), null);
  assert.equal(readSessionAiTitle("C:\\code\\never", { projectsDir: dir }), null);
});

test("readSessionName / readSessionAiTitle return null when there are no JSONL files", () => {
  const dir = tmpProjectsDir();
  fs.mkdirSync(path.join(dir, "C--code-empty"), { recursive: true });
  assert.equal(readSessionName("C:\\code\\empty", { projectsDir: dir }), null);
  assert.equal(readSessionAiTitle("C:\\code\\empty", { projectsDir: dir }), null);
});

test("readers tolerate unparseable lines (partial split at the tail boundary)", () => {
  const dir = tmpProjectsDir();
  writeSession(dir, "C--code-messy", "s1", [
    `{"type":"custom-title","customTitle":"Real Name","sessionId":"s1"}`,
    `this is not json`,
    `{incomplete`,
    `{"type":"custom-title","customTitle":"Final Name","sessionId":"s1"}`,
    `{"type":"ai-title","aiTitle":"Final Auto","sessionId":"s1"}`,
  ]);
  assert.equal(readSessionName("C:\\code\\messy", { projectsDir: dir }), "Final Name");
  assert.equal(readSessionAiTitle("C:\\code\\messy", { projectsDir: dir }), "Final Auto");
});

// A custom title can be set hours ago on a transcript that has grown megabytes
// since — a fixed last-1MB tail read misses it and the channel gets a
// context-free name. The scan must cover the whole file, chunked.
test("readSessionName finds a custom-title set further back than the last 1 MB", () => {
  const dir = tmpProjectsDir();
  const filler = `{"type":"message","content":"${"x".repeat(200)}"}`;
  const lines = [`{"type":"custom-title","customTitle":"Ancient Name","sessionId":"s1"}`];
  const need = Math.ceil(1_100_000 / (filler.length + 1));
  for (let i = 0; i < need; i++) lines.push(filler);
  writeSession(dir, "C--code-huge", "s1", lines);
  assert.equal(readSessionName("C:\\code\\huge", { projectsDir: dir }), "Ancient Name",
    "a title beyond the last 1 MB must still be found");
});

test("full seize-name precedence: custom title > session-derived name > ai-title (never cwd)", () => {
  const dir = tmpProjectsDir();
  writeSession(dir, "C--code-long-night", "s1", [
    `{"type":"ai-title","aiTitle":"Greeting GLM","sessionId":"s1"}`,
    `{"type":"custom-title","customTitle":"can-you-read-this-name","sessionId":"s1"}`,
  ]);
  // Mirrors the precedence in server.mjs slack_seize:
  //   readSessionName(_cwd) || args.name || readSessionAiTitle(_cwd) || null
  const derive = (args = {}) =>
    readSessionName("C:\\code\\long-night", { projectsDir: dir }) ||
    args.name ||
    readSessionAiTitle("C:\\code\\long-night", { projectsDir: dir }) ||
    null;
  // Custom title wins even when the session passes a derived name:
  assert.equal(derive({ name: "slack-remote-setup" }), "can-you-read-this-name");
  assert.equal(derive({}), "can-you-read-this-name"); // custom title is the default
  // When no custom title: session-derived name beats ai-title.
  const dir2 = tmpProjectsDir();
  writeSession(dir2, "C--code-long-night", "s1", [
    `{"type":"ai-title","aiTitle":"Greeting GLM","sessionId":"s1"}`,
  ]);
  const derive2 = (args = {}) =>
    readSessionName("C:\\code\\long-night", { projectsDir: dir2 }) ||
    args.name ||
    readSessionAiTitle("C:\\code\\long-night", { projectsDir: dir2 }) ||
    null;
  assert.equal(derive2({ name: "slack-remote-setup" }), "slack-remote-setup"); // session-derived slug
  assert.equal(derive2({}), "Greeting GLM"); // no title, no name → ai-title last resort
  // When nothing is readable at all: null (daemon falls back to peer-id fragment).
  const dir3 = tmpProjectsDir();
  const derive3 = (args = {}) =>
    readSessionName("C:\\code\\long-night", { projectsDir: dir3 }) ||
    args.name ||
    readSessionAiTitle("C:\\code\\long-night", { projectsDir: dir3 }) ||
    null;
  assert.equal(derive3({}), null); // never cwd basename — null signals "broke"
});

// --- delivery: background waiter ---

function tmpState() {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), "slack-remote-mcp-")), "state.json");
}

async function serverWithBroker(t, { sessionId = "session-123", sessionReader = () => ({ sessionId }) } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "slack-remote-mcp-state-"));
  const stateDir = path.join(root, "state");
  const broker = createBroker({ stateFile: tmpState() });
  t.after(() => broker.close());
  const port = await broker.listen(0);
  const config = {
    remote: { brokerPort: port, controlPort: 0, controlToken: "t", heartbeatIntervalMs: 60_000 },
  };
  const server = createRemoteMcpServer({
    config, configPath: "/tmp/remote-config.json", input: new PassThrough(), output: new PassThrough(),
    _getPaths: () => ({ stateDir }), _readSession: sessionReader,
    _fetch: async (url, options) => {
      if (url.endsWith("/claim")) return new Response(JSON.stringify({ ok: true, channel: "C123", channel_name: "test" }));
      if (url.endsWith("/release")) return new Response(JSON.stringify({ ok: true }));
      return fetch(url, options);
    },
  });
  await server.start();
  const call = async (p, body) =>
    (await fetch(`http://127.0.0.1:${port}${p}`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
    })).json();
  return { server, broker, call, port, stateDir };
}

test("initialize: instructions describe seize, background wait, normal reply and re-arm", async (t) => {
  const { server } = await serverWithBroker(t);
  const res = await server._onRequest("initialize", {});
  assert.equal(res.instructions, INSTRUCTIONS);
  assert.match(res.instructions, /run_in_background/);
  assert.match(res.instructions, /bash_timeout_ms/);
  assert.match(res.instructions, /reply normally/);
  assert.match(res.instructions, /re-arm/);
  assert.doesNotMatch(res.instructions, /CronCreate|slack_post|<channel source=/);
});

test("slack_seize returns wait command and timeout, and writes the session mapping", async (t) => {
  const { server, stateDir } = await serverWithBroker(t);
  const result = await server._onRequest("tools/call", { name: "slack_seize", arguments: {} });
  const value = result.content[0].text;
  assert.match(value, /Run the wait command/);
  assert.equal(result.wait_command, waitCommand(server._myId(), { configPath: "/tmp/remote-config.json" }));
  assert.equal(result.bash_timeout_ms, BASH_TIMEOUT_MS);
  const mapping = JSON.parse(fs.readFileSync(path.join(stateDir, "remote-sessions", "session-123.json"), "utf8"));
  assert.deepEqual(mapping, { peerId: server._myId(), configPath: "/tmp/remote-config.json", channel: "C123" });
});

test("slack_release deletes the session mapping", async (t) => {
  const { server, stateDir } = await serverWithBroker(t);
  await server._onRequest("tools/call", { name: "slack_seize", arguments: {} });
  await server._onRequest("tools/call", { name: "slack_release", arguments: {} });
  assert.equal(fs.existsSync(path.join(stateDir, "remote-sessions", "session-123.json")), false);
});

test("server shutdown deletes the session mapping", async (t) => {
  const { server, stateDir } = await serverWithBroker(t);
  await server._onRequest("tools/call", { name: "slack_seize", arguments: {} });
  server.shutdown();
  assert.equal(fs.existsSync(path.join(stateDir, "remote-sessions", "session-123.json")), false);
});
test("start registers the session id read from the parent process session file", async (t) => {
  const { server, broker } = await serverWithBroker(t, { sessionReader: (pid) => {
    assert.equal(pid, process.ppid);
    return { sessionId: "injected-session" };
  } });
  const peer = (await server._brokerFetch("/list-peers", { scope: "machine", cwd: "", git_root: null })).find((p) => p.id === server._myId());
  assert.equal(peer.session_id, "injected-session");
});// --- dormant (no remote.controlToken) ---
// The manifest declares this server, so it loads in every plugin-installed
// session — including installs that never ran setup. Dormant means dormant: a
// clean "off" (no tools, honest instructions), and start() touches nothing —
// no broker spawn, no timers, no registration into a live broker's state.

test("no controlToken: initialize reports not-configured, tools/list is empty, tools/call refuses", async () => {
  const server = createRemoteMcpServer({
    config: { remote: { brokerPort: 59998, controlPort: 0, controlToken: null } },
    input: new PassThrough(),
    output: new PassThrough(),
  });
  const init = await server._onRequest("initialize", {});
  assert.match(init.instructions, /not configured/);
  const tools = await server._onRequest("tools/list", {});
  assert.deepEqual(tools.tools, []);
  await assert.rejects(server._onRequest("tools/call", { name: "slack_seize" }), /not configured/);
});

test("no controlToken: start() starts nothing — no broker spawn, no timers, no registration", async () => {
  const server = createRemoteMcpServer({
    config: { remote: { brokerPort: 59998, controlPort: 0, controlToken: null, heartbeatIntervalMs: 60_000 } },
    input: new PassThrough(),
    output: new PassThrough(),
    _spawn: () => { throw new Error("dormant server must not spawn the broker"); },
    _setInterval: () => { throw new Error("dormant server must not start timers"); },
  });
  await server.start(); // must return early, not reject with the injected errors
  assert.equal(server._myId(), null, "dormant server must not register");
});

test("a config with no remote key at all constructs dormant (defensive factory)", async () => {
  const server = createRemoteMcpServer({ config: {}, input: new PassThrough(), output: new PassThrough() });
  const init = await server._onRequest("initialize", {});
  assert.match(init.instructions, /not configured/);
  assert.deepEqual((await server._onRequest("tools/list", {})).tools, []);
});

// --- broker auth (mirrors the control endpoint's token guard) ---

test("brokerFetch sends the Bearer header — requests against a token-guarded broker succeed", async (t) => {
  const broker = createBroker({ stateFile: tmpState(), token: "t" });
  t.after(() => broker.close());
  const port = await broker.listen(0);
  const server = createRemoteMcpServer({
    config: { remote: { brokerPort: port, controlPort: 0, controlToken: "t", heartbeatIntervalMs: 60_000 } },
    input: new PassThrough(),
    output: new PassThrough(),
  });
  const peers = await server._brokerFetch("/list-peers", { scope: "machine", cwd: "x", git_root: null });
  assert.ok(Array.isArray(peers), "a token-guarded broker must accept the server's credentialed fetch");
});
