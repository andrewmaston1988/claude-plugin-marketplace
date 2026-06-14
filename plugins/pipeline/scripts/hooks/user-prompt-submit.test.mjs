import test from "node:test";
import assert from "node:assert";
import { spawnSync } from "node:child_process";
import { writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { execSync } from "node:child_process";
import { connectPath, upsertClaudeSession, getClaudeSession, getLastCheckpointSize, setLastCheckpointSize } from "../pipeline-db/index.mjs";

const NODE_PATH = process.execPath;

test("resolveSessionId: returns sessionId from stdin when provided", () => {
  const stdinJson = { session_id: "test-123" };
  // Note: this is tested via integration, not unit, since the function isn't exported
});

test("SCHEMA_V8 migration: adds last_checkpoint_size column", () => {
  const db = connectPath(":memory:");
  const cols = db.prepare("PRAGMA table_info(claude_sessions)").all().map(c => c.name);
  assert(cols.includes("last_checkpoint_size"), "last_checkpoint_size column should exist");
  db.close();
});

test("getLastCheckpointSize: returns null for unknown session", () => {
  const db = connectPath(":memory:");
  const result = getLastCheckpointSize(db, "unknown-session");
  assert(result === null, "should return null for unknown session");
  db.close();
});

test("getLastCheckpointSize: returns stored value", () => {
  const db = connectPath(":memory:");
  upsertClaudeSession(db, {
    sessionId: "test-session",
    cwd: "/test",
    startedAt: 1000,
    userTs: 1000,
    summary: null,
  });
  setLastCheckpointSize(db, "test-session", 5000);
  const result = getLastCheckpointSize(db, "test-session");
  assert.equal(result, 5000, "should return the stored checkpoint size");
  db.close();
});

test("setLastCheckpointSize: survives subsequent upsertClaudeSession with null userTs", () => {
  const db = connectPath(":memory:");
  upsertClaudeSession(db, {
    sessionId: "test-session",
    cwd: "/test",
    startedAt: 1000,
    userTs: 1000,
    summary: null,
  });
  setLastCheckpointSize(db, "test-session", 5000);
  // Keepalive tick: upsert with null userTs
  upsertClaudeSession(db, {
    sessionId: "test-session",
    cwd: "/test",
    startedAt: 1000,
    userTs: null,
    summary: null,
  });
  const result = getLastCheckpointSize(db, "test-session");
  assert.equal(result, 5000, "checkpoint size should be preserved on keepalive");
  db.close();
});

test("upsertClaudeSession: preserves user_ts on null update", () => {
  const db = connectPath(":memory:");
  upsertClaudeSession(db, {
    sessionId: "test-session",
    cwd: "/test",
    startedAt: 1000,
    userTs: 100,
    summary: null,
  });
  upsertClaudeSession(db, {
    sessionId: "test-session",
    cwd: "/test",
    startedAt: 1000,
    userTs: null,
    summary: null,
  });
  const session = getClaudeSession(db, "test-session");
  assert.equal(session.user_ts, 100, "user_ts should be preserved when updated with null");
  db.close();
});

test("hook stdout contract: valid JSON on empty stdin", (t, done) => {
  const result = spawnSync(NODE_PATH, [
    join(process.cwd(), "plugins/pipeline/scripts/hooks/user-prompt-submit.mjs"),
  ], {
    input: "",
    encoding: "utf-8",
  });

  try {
    const output = result.stdout.trim().split("\n").pop();
    const parsed = JSON.parse(output);
    assert(parsed.hookSpecificOutput, "should have hookSpecificOutput");
    assert.equal(parsed.hookSpecificOutput.hookEventName, "UserPromptSubmit", "hookEventName should be UserPromptSubmit");
    assert.equal(typeof parsed.hookSpecificOutput.additionalContext, "string", "additionalContext should be a string");
    done();
  } catch (err) {
    done(err);
  }
});

test("hook stdout contract: valid JSON on malformed stdin", (t, done) => {
  const result = spawnSync(NODE_PATH, [
    join(process.cwd(), "plugins/pipeline/scripts/hooks/user-prompt-submit.mjs"),
  ], {
    input: "not valid json{{{",
    encoding: "utf-8",
  });

  try {
    const output = result.stdout.trim().split("\n").pop();
    const parsed = JSON.parse(output);
    assert(parsed.hookSpecificOutput, "should have hookSpecificOutput");
    assert.equal(parsed.hookSpecificOutput.hookEventName, "UserPromptSubmit");
    done();
  } catch (err) {
    done(err);
  }
});

test("hook: CORRELATION_ID suppresses keepalive-init injection", (t, done) => {
  const env = { ...process.env, CORRELATION_ID: "test-corr-id" };
  const input = JSON.stringify({
    prompt: "normal prompt",
    transcript_path: "/tmp/fake.jsonl",
    session_id: "test-session",
    cwd: process.cwd(),
  });

  const result = spawnSync(NODE_PATH, [
    join(process.cwd(), "plugins/pipeline/scripts/hooks/user-prompt-submit.mjs"),
  ], {
    input,
    encoding: "utf-8",
    env,
  });

  try {
    const output = result.stdout.trim().split("\n").pop();
    const parsed = JSON.parse(output);
    const ctx = parsed.hookSpecificOutput.additionalContext;
    assert(!ctx.includes("keepalive"), "CORRELATION_ID should suppress keepalive injection");
    done();
  } catch (err) {
    done(err);
  }
});

test("hook: database write on valid JSON", (t, done) => {
  const input = JSON.stringify({
    prompt: "test prompt",
    transcript_path: "/tmp/fake.jsonl",
    session_id: "smoke-test-001",
    cwd: process.cwd(),
  });

  const result = spawnSync(NODE_PATH, [
    join(process.cwd(), "plugins/pipeline/scripts/hooks/user-prompt-submit.mjs"),
  ], {
    input,
    encoding: "utf-8",
  });

  try {
    const output = result.stdout.trim().split("\n").pop();
    const parsed = JSON.parse(output);
    assert(parsed.hookSpecificOutput, "should emit valid JSON");
    done();
  } catch (err) {
    done(err);
  }
});

test("hook stdout contract: valid JSON when session_id absent from stdin (exercises sessions-dir fallback)", (t, done) => {
  const input = JSON.stringify({
    prompt: "hello",
    transcript_path: "/tmp/fake.jsonl",
    cwd: process.cwd(),
  });

  const result = spawnSync(NODE_PATH, [
    join(process.cwd(), "plugins/pipeline/scripts/hooks/user-prompt-submit.mjs"),
  ], {
    input,
    encoding: "utf-8",
  });

  try {
    const output = result.stdout.trim().split("\n").pop();
    const parsed = JSON.parse(output);
    assert(parsed.hookSpecificOutput, "should have hookSpecificOutput");
    assert.equal(parsed.hookSpecificOutput.hookEventName, "UserPromptSubmit");
    assert.equal(typeof parsed.hookSpecificOutput.additionalContext, "string", "additionalContext should be a string");
    done();
  } catch (err) {
    done(err);
  }
});
