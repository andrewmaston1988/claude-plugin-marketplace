import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadConfig } from "../src/config.mjs";

const SLACK_ENV_KEYS = ["SLACK_BOT_TOKEN", "SLACK_APP_TOKEN", "CLAUDE_CWD"];

function saveEnv() {
  const saved = {};
  for (const k of SLACK_ENV_KEYS) saved[k] = process.env[k];
  for (const k of SLACK_ENV_KEYS) delete process.env[k];
  return saved;
}

function restoreEnv(saved) {
  for (const k of SLACK_ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
}

function tmpConfig(obj) {
  const dir = join(tmpdir(), `claude-slack-test-${process.pid}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, "config.json");
  writeFileSync(path, JSON.stringify(obj), "utf8");
  return { path, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test("config — valid config loads with defaults merged", () => {
  const env = saveEnv();
  const { path, cleanup } = tmpConfig({
    tokens: { bot: "xoxb-test", app: "xapp-test" },
    claude: { cwd: "/tmp" },
  });
  try {
    const cfg = loadConfig({ configPath: path });
    assert.equal(cfg.tokens.bot, "xoxb-test");
    assert.equal(cfg.tokens.app, "xapp-test");
    assert.equal(cfg.claude.timeout, 180_000, "default timeout applied");
    assert.equal(cfg.slack.sessionKey, "channel-thread", "default sessionKey applied");
    assert.deepEqual(cfg.extensions, [], "default extensions applied");
  } finally {
    restoreEnv(env);
    cleanup();
  }
});

test("config — missing required field tokens.app throws actionable message", () => {
  const env = saveEnv();
  const { path, cleanup } = tmpConfig({ tokens: { bot: "xoxb-test" }, claude: { cwd: "/tmp" } });
  try {
    assert.throws(() => loadConfig({ configPath: path }), /tokens\.app/);
  } finally {
    restoreEnv(env);
    cleanup();
  }
});

test("config — missing claude.cwd throws", () => {
  const env = saveEnv();
  const { path, cleanup } = tmpConfig({ tokens: { bot: "xoxb-test", app: "xapp-test" } });
  try {
    assert.throws(() => loadConfig({ configPath: path }), /claude\.cwd/);
  } finally {
    restoreEnv(env);
    cleanup();
  }
});

test("config — file not found throws with setup hint", () => {
  assert.throws(
    () => loadConfig({ configPath: "/nonexistent/path/config.json" }),
    /Config file not found/
  );
});

test("config — invalid JSON throws with file path", () => {
  const dir = join(tmpdir(), `claude-slack-test-json-${process.pid}`);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, "config.json");
  writeFileSync(path, "{ bad json }", "utf8");
  try {
    assert.throws(() => loadConfig({ configPath: path }), /not valid JSON/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("config — SLACK_BOT_TOKEN env var overrides file token", () => {
  const env = saveEnv();
  const { path, cleanup } = tmpConfig({
    tokens: { bot: "xoxb-file", app: "xapp-test" },
    claude: { cwd: "/tmp" },
  });
  process.env.SLACK_BOT_TOKEN = "xoxb-from-env";
  try {
    const cfg = loadConfig({ configPath: path });
    assert.equal(cfg.tokens.bot, "xoxb-from-env");
  } finally {
    restoreEnv(env);
    cleanup();
  }
});

test("config — invalid claude.timeout (string) throws", () => {
  const env = saveEnv();
  const { path, cleanup } = tmpConfig({
    tokens: { bot: "xoxb-test", app: "xapp-test" },
    claude: { cwd: "/tmp", timeout: "not-a-number" },
  });
  try {
    assert.throws(() => loadConfig({ configPath: path }), /claude\.timeout.*positive number/);
  } finally {
    restoreEnv(env);
    cleanup();
  }
});

test("config — invalid claude.timeout (zero) throws", () => {
  const env = saveEnv();
  const { path, cleanup } = tmpConfig({
    tokens: { bot: "xoxb-test", app: "xapp-test" },
    claude: { cwd: "/tmp", timeout: 0 },
  });
  try {
    assert.throws(() => loadConfig({ configPath: path }), /claude\.timeout.*positive number/);
  } finally {
    restoreEnv(env);
    cleanup();
  }
});

test("config — valid numeric claude.timeout loads", () => {
  const env = saveEnv();
  const { path, cleanup } = tmpConfig({
    tokens: { bot: "xoxb-test", app: "xapp-test" },
    claude: { cwd: "/tmp", timeout: 60_000 },
  });
  try {
    const cfg = loadConfig({ configPath: path });
    assert.equal(cfg.claude.timeout, 60_000);
  } finally {
    restoreEnv(env);
    cleanup();
  }
});
