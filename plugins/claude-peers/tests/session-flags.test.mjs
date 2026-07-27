import { test } from "node:test";
import assert from "node:assert/strict";

import {
  channelsEnabled,
  findSessionClaude,
  detectChannelsEnabled,
  readProcTableWindows,
} from "../src/session-flags.mjs";

const ROW = [{ ProcessId: 1, ParentProcessId: 0, CommandLine: "claude" }];
const notFound = () => { const e = new Error("spawn ENOENT"); e.code = "ENOENT"; throw e; };

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

test("channelsEnabled: only the flag's own values count, not a later mention", () => {
  // a prompt body naming this plugin must not read as an allowlist entry —
  // false here costs a poll, true costs every message the session is sent
  assert.equal(
    channelsEnabled('claude --channels plugin:slack-bridge -p "fix plugin:claude-peers polling"'),
    false,
  );
  assert.equal(
    channelsEnabled("claude --channels plugin:slack-bridge --some-other-flag plugin:claude-peers"),
    false,
  );
  assert.equal(channelsEnabled("claude --channels=plugin:claude-peers@mkt"), true);
  assert.equal(channelsEnabled("claude --channels plugin:slack-bridge plugin:claude-peers@mkt"), true);
});

test("readProcTableWindows prefers pwsh and falls back when it is absent", () => {
  const tried = [];
  const rows = readProcTableWindows((exe) => {
    tried.push(exe);
    if (exe === "pwsh") notFound();
    return JSON.stringify(ROW);
  });
  assert.deepEqual(tried, ["pwsh", "powershell"]);
  assert.deepEqual(rows, [{ pid: 1, ppid: 0, cmd: "claude" }]);
  assert.deepEqual(readProcTableWindows(() => JSON.stringify(ROW)), rows);
});

test("readProcTableWindows caps the handshake at one shell budget", () => {
  const tried = [];
  // a hung pwsh must surface, not spend a second timeout on powershell —
  // this runs inside the MCP initialize handler
  assert.throws(() => readProcTableWindows((exe, _args, opts) => {
    tried.push([exe, opts.timeout]);
    const e = new Error("ETIMEDOUT"); e.code = "ETIMEDOUT"; throw e;
  }), /ETIMEDOUT/);
  assert.deepEqual(tried, [["pwsh", 3000]]);
});

test("findSessionClaude walks ancestors to the claude process", () => {
  const table = [
    { pid: 100, ppid: 90, cmd: "node claude-peers.mjs mcp" },
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

test("detectChannelsEnabled reads the owning session's launch flags", () => {
  const table = [
    { pid: 10, ppid: 9, cmd: CLAUDE_WITH_FLAG },
    { pid: 20, ppid: 19, cmd: CLAUDE_NO_FLAG },
  ];
  assert.equal(detectChannelsEnabled({ _readProcTable: () => table, _ppid: 10 }), true);
  assert.equal(detectChannelsEnabled({ _readProcTable: () => table, _ppid: 20 }), false);
});

test("detectChannelsEnabled resolves unknown to false so the session polls", () => {
  assert.equal(detectChannelsEnabled({ _readProcTable: () => [], _ppid: 1 }), false);
  assert.equal(
    detectChannelsEnabled({ _readProcTable: () => { throw new Error("ps failed"); }, _ppid: 1 }),
    false,
    "a broken process table must not leave the session waiting on a push it cannot receive",
  );
});
