import { test } from "node:test";
import { equal, ok } from "node:assert/strict";
import { join } from "node:path";
import { findClaudeSlackPlugin } from "../src/locators/claude-slack.mjs";

test("env override wins when file exists", () => {
  const env = { CLAUDE_SLACK_PLUGIN: "/abs/custom/claude-slack.mjs", HOME: "/home/u" };
  const existsSync = (p) => p === "/abs/custom/claude-slack.mjs";
  const r = findClaudeSlackPlugin({ _env: env, _existsSync: existsSync });
  equal(r.source, "env");
  equal(r.path,   "/abs/custom/claude-slack.mjs");
});

test("env override ignored when file missing → cache walk wins", () => {
  const env = { CLAUDE_SLACK_PLUGIN: "/abs/missing.mjs", HOME: "/home/u", PATH: "" };
  const cacheRoot   = join("/home/u", ".claude", "plugins", "cache");
  const ownerDir    = join(cacheRoot, "owner");
  const sbDir       = join(ownerDir, "slack-bridge");
  const verDir      = join(sbDir, "0.1.0");
  const exe         = join(verDir, "bin", "claude-slack.mjs");
  const existsSync = (p) => {
    if (p === "/abs/missing.mjs") return false;
    if (p === cacheRoot) return true;
    if (p === sbDir) return true;
    if (p === exe) return true;
    return false;
  };
  const readdirSync = (p) => {
    if (p === cacheRoot) return ["owner"];
    if (p === sbDir) return ["0.1.0"];
    throw new Error(`unexpected readdirSync: ${p}`);
  };
  const r = findClaudeSlackPlugin({ _env: env, _existsSync: existsSync, _readdirSync: readdirSync });
  equal(r.source, "cache");
  equal(r.path, exe);
});

test("cache walk skips owners without slack-bridge dir", () => {
  const env = { HOME: "/home/u", PATH: "" };
  const cacheRoot = join("/home/u", ".claude", "plugins", "cache");
  const owner2sb  = join(cacheRoot, "owner2", "slack-bridge");
  const ver       = join(owner2sb, "1.2.3");
  const exe       = join(ver, "bin", "claude-slack.mjs");
  const existsSync = (p) => p === cacheRoot || p === owner2sb || p === exe;
  const readdirSync = (p) => {
    if (p === cacheRoot) return ["owner1", "owner2"];      // owner1 has no slack-bridge
    if (p === owner2sb) return ["1.2.3"];
    throw new Error(`unexpected readdirSync: ${p}`);
  };
  const r = findClaudeSlackPlugin({ _env: env, _existsSync: existsSync, _readdirSync: readdirSync });
  equal(r.source, "cache");
  equal(r.path, exe);
});

test("cache walk tolerates unreadable directory and falls through", () => {
  const env = { HOME: "/home/u", PATH: "" };
  const cacheRoot = join("/home/u", ".claude", "plugins", "cache");
  const existsSync = (p) => p === cacheRoot;
  const readdirSync = () => { throw new Error("EACCES"); };
  const r = findClaudeSlackPlugin({ _env: env, _existsSync: existsSync, _readdirSync: readdirSync });
  // Should not throw; nothing on PATH either → null.
  equal(r.path, null);
});

test("PATH walk discovers binary when no env override and no cache", () => {
  // join() emits OS-native separators; match by suffix to stay cross-platform.
  const env = {
    HOME: "/home/u",
    PATH: "/usr/local/bin:/usr/bin",
  };
  const existsSync = (p) => /claude-slack(\.exe|\.cmd|\.bat|\.mjs|\.js)?$/.test(p)
    && /[\\/]usr[\\/]local[\\/]bin[\\/]/.test(p);
  const r = findClaudeSlackPlugin({ _env: env, _existsSync: existsSync });
  equal(r.source, "path");
  ok(/claude-slack/.test(r.path));
});

test("returns {path: null, source: null} when nothing found", () => {
  const env = { HOME: "/home/u", PATH: "/nope" };
  const existsSync = () => false;
  const r = findClaudeSlackPlugin({ _env: env, _existsSync: existsSync });
  equal(r.path,   null);
  equal(r.source, null);
});

test("env override checked before PATH walk", () => {
  // Same binary on both env and PATH — env must win.
  const env = {
    CLAUDE_SLACK_PLUGIN: "/abs/env-pick.mjs",
    HOME: "/home/u",
    PATH: "/usr/bin",
  };
  const existsSync = (p) => p === "/abs/env-pick.mjs" || /claude-slack/.test(p);
  const r = findClaudeSlackPlugin({ _env: env, _existsSync: existsSync });
  equal(r.source, "env");
});
