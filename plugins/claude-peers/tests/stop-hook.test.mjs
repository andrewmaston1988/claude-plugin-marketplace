import { test } from "node:test";
import assert from "node:assert/strict";

import {
  channelsEnabled,
  findSessionClaude,
  findMyPeer,
  decideStop,
} from "../src/hooks/stop.mjs";

const CLAUDE_WITH_FLAG =
  '"C:\\Users\\A\\.local\\bin\\claude.exe" --model claude-opus-4-8 ' +
  "--dangerously-load-development-channels plugin:claude-peers@mkt plugin:slack-bridge@mkt";
const CLAUDE_NO_FLAG = '"C:\\Users\\A\\.local\\bin\\claude.exe" --model glm-5.2:cloud';

test("channelsEnabled: true only when the channels flag names claude-peers", () => {
  assert.equal(channelsEnabled(CLAUDE_WITH_FLAG), true);
  assert.equal(channelsEnabled(CLAUDE_NO_FLAG), false);
  // flag present but this plugin not in the allowlist — channels won't render ours
  assert.equal(
    channelsEnabled("claude --dangerously-load-development-channels plugin:slack-bridge@mkt"),
    false,
  );
  assert.equal(channelsEnabled(""), false);
});

test("findSessionClaude walks ancestors to the claude process", () => {
  const table = [
    { pid: 100, ppid: 90, cmd: "node hook.mjs" },
    { pid: 90, ppid: 80, cmd: '"C:\\Program Files\\Git\\bin\\bash.exe" -c ...' },
    { pid: 80, ppid: 1, cmd: CLAUDE_WITH_FLAG },
  ];
  assert.deepEqual(findSessionClaude(table, 100), { pid: 80, cmd: CLAUDE_WITH_FLAG });
});

test("findSessionClaude returns null when no claude ancestor exists", () => {
  const table = [{ pid: 5, ppid: 0, cmd: "node something.mjs" }];
  assert.equal(findSessionClaude(table, 5), null);
});

test("findSessionClaude terminates on a parent cycle", () => {
  const table = [
    { pid: 1, ppid: 2, cmd: "a" },
    { pid: 2, ppid: 1, cmd: "b" },
  ];
  assert.equal(findSessionClaude(table, 1), null);
});

test("findMyPeer matches the peer whose pid descends from this session's claude", () => {
  const table = [
    { pid: 80, ppid: 1, cmd: CLAUDE_NO_FLAG },
    { pid: 81, ppid: 80, cmd: "node claude-peers.mjs mcp" },
    { pid: 200, ppid: 1, cmd: CLAUDE_NO_FLAG },
    { pid: 201, ppid: 200, cmd: "node claude-peers.mjs mcp" },
  ];
  const peers = [
    { id: "other", pid: 201, cwd: "C:/x" },
    { id: "mine", pid: 81, cwd: "C:/x" },
  ];
  // same cwd for both — only the process tree disambiguates
  assert.equal(findMyPeer(peers, table, 80)?.id, "mine");
  assert.equal(findMyPeer(peers, table, 200)?.id, "other");
});

test("findMyPeer returns null when no peer belongs to this session", () => {
  const table = [{ pid: 80, ppid: 1, cmd: CLAUDE_NO_FLAG }];
  assert.equal(findMyPeer([{ id: "x", pid: 999, cwd: "C:/x" }], table, 80), null);
});

test("decideStop: allows the stop when channels are enabled, without draining", async () => {
  let took = false;
  const out = await decideStop({
    payload: {},
    claude: { pid: 80, cmd: CLAUDE_WITH_FLAG },
    take: async () => { took = true; return []; },
  });
  assert.equal(out, null);
  assert.equal(took, false, "must not consume messages a channel notification already delivered");
});

test("decideStop: blocks with pending messages when channels are absent", async () => {
  const out = await decideStop({
    payload: {},
    claude: { pid: 80, cmd: CLAUDE_NO_FLAG },
    take: async () => [{ from_id: "abc", text: "ping" }],
  });
  assert.equal(out.decision, "block");
  assert.match(out.reason, /abc/);
  assert.match(out.reason, /ping/);
});

test("decideStop: allows the stop when nothing is pending", async () => {
  const out = await decideStop({
    payload: {},
    claude: { pid: 80, cmd: CLAUDE_NO_FLAG },
    take: async () => [],
  });
  assert.equal(out, null);
});

test("decideStop: honours stop_hook_active so it never blocks twice", async () => {
  let took = false;
  const out = await decideStop({
    payload: { stop_hook_active: true },
    claude: { pid: 80, cmd: CLAUDE_NO_FLAG },
    take: async () => { took = true; return [{ from_id: "a", text: "b" }]; },
  });
  assert.equal(out, null);
  assert.equal(took, false);
});

test("decideStop: fails open when the broker throws", async () => {
  const out = await decideStop({
    payload: {},
    claude: { pid: 80, cmd: CLAUDE_NO_FLAG },
    take: async () => { throw new Error("broker down"); },
  });
  assert.equal(out, null);
});

test("decideStop: fails open when the claude ancestor cannot be found", async () => {
  let took = false;
  const out = await decideStop({
    payload: {},
    claude: null,
    take: async () => { took = true; return []; },
  });
  assert.equal(out, null);
  assert.equal(took, false, "unknown session identity must not consume messages");
});
