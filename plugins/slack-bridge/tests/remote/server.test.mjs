// The slack_seize name-derivation path: custom-title → session-derived name →
// ai-title → daemon peer-id fragment; the cwd basename is never used.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { readSessionName, readSessionAiTitle, encodeCwd, createRemoteMcpServer, POLLING_INSTRUCTIONS } from "../../src/remote-mcp/server.mjs";
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

// --- delivery: push or poll (matches claude-peers' current server) ---
// A session launched without the --channels allowlist never renders a push, and
// cloud-model sessions cannot render one at all. The handshake must detect
// that and instruct the session to poll — otherwise inbound Slack messages are
// silently destroyed on exactly the sessions remote control exists for.

function tmpState() {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), "slack-remote-mcp-")), "state.json");
}

async function serverWithBroker(t, { detect = () => false } = {}) {
  const broker = createBroker({ stateFile: tmpState() });
  t.after(() => broker.close());
  const port = await broker.listen(0);
  const config = {
    remote: { brokerPort: port, controlPort: 0, controlToken: "t", pollIntervalMs: 60_000, heartbeatIntervalMs: 60_000 },
  };
  // PassThrough, not process.stdin/stdout: the rpc endpoint's listeners on the
  // real stdin are a live handle that keeps the test runner from ever exiting.
  const server = createRemoteMcpServer({
    config,
    input: new PassThrough(),
    output: new PassThrough(),
    _detectChannels: detect,
  });
  await server._register();
  const call = async (p, body) =>
    (await fetch(`http://127.0.0.1:${port}${p}`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
    })).json();
  return { server, broker, call, port };
}

test("initialize: channels unavailable appends the poll directive (CronCreate check_messages)", async (t) => {
  const { server } = await serverWithBroker(t, { detect: () => false });
  const res = await server._onRequest("initialize", {});
  assert.ok(res.instructions.includes("CronCreate"),
    "a session that cannot render pushes must be told to poll");
  assert.ok(res.instructions.includes(POLLING_INSTRUCTIONS),
    "the poll directive must be the concrete, copyable steps");
});

test("initialize: channels available ships the push instructions without the poll directive", async (t) => {
  const { server } = await serverWithBroker(t, { detect: () => true });
  const res = await server._onRequest("initialize", {});
  assert.ok(res.instructions.includes("<channel source=\"slack-bridge\">"),
    "push instructions must describe the channel block");
  assert.ok(!res.instructions.includes(POLLING_INSTRUCTIONS),
    "an allowlisted session must not be told to poll");
});

test("check_messages recovers a message the push timer already drained (the operator-facing defect)", async (t) => {
  const { server, call } = await serverWithBroker(t);
  const myId = server._myId();
  assert.ok(myId, "test hook must expose the registered peer id");
  // the daemon routes an inbound Slack message to the live session's peer id
  await call("/send-message", { from_id: "slack-bridge", to_id: myId, text: "hello from mobile" });
  // the server's own push timer drains the queue within a second of arrival —
  // on a session that never renders the push, this is where messages died
  await server._poll();
  // check_messages is the documented recovery: it must still find the message
  const res = await server._onRequest("tools/call", { name: "check_messages" });
  assert.ok(res.content[0].text.includes("hello from mobile"),
    "a message pushed-but-unrendered must survive to check_messages");
});
