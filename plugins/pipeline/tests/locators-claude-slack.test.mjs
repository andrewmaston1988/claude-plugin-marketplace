// Tests for findClaudeSlackPlugin — the shared locator extracted from
// wizard.mjs and doctor.mjs by paths-and-config-base. Resolution order:
// env > cache walk > PATH > null.
import { test } from "node:test";
import { equal, ok } from "node:assert/strict";
import { findClaudeSlackPlugin } from "../src/locators/claude-slack.mjs";

// All probes go through injection seams (_env, _existsSync) so the tests
// never depend on the real filesystem or process environment.

test("env override wins when file exists", () => {
  const env = { CLAUDE_SLACK_PLUGIN: "/abs/custom/claude-slack.mjs", HOME: "/home/u" };
  const existsSync = (p) => p === "/abs/custom/claude-slack.mjs";
  const r = findClaudeSlackPlugin({ _env: env, _existsSync: existsSync });
  equal(r.source, "env");
  equal(r.path,   "/abs/custom/claude-slack.mjs");
});

test("env override is ignored when file missing → cache wins", () => {
  const env = { CLAUDE_SLACK_PLUGIN: "/abs/missing.mjs", HOME: "/home/u", PATH: "" };
  // existsSync returns true for cache root + a single bundled entry.
  const existsSync = (p) => p === "/abs/missing.mjs" ? false :
    p === "/home/u/.claude/plugins/cache" ? true :
    p === "/home/u/.claude/plugins/cache/owner/slack-bridge" ? true :
    /claude-slack\.mjs$/.test(p);
  // readdirSync isn't injectable yet; for the cache walk the locator uses
  // node:fs.readdirSync directly. We simulate the env-fail path here by
  // checking it doesn't return source="env".
  const r = findClaudeSlackPlugin({ _env: env, _existsSync: existsSync });
  ok(r.source !== "env", "should not return env when file missing");
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
