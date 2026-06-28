// claude_sessions table helpers round-trip tests
import { test } from "node:test";
import { equal, ok, deepEqual } from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  connectPath, close, projectAdd,
  upsertClaudeSession, getClaudeSession, listActiveClaudeSessionsByCwd,
  getLastCheckpointSize, setLastCheckpointSize, listAllClaudeSessionIds,
} from "../src/db/index.mjs";

const PROJECT = "testproject";

function setup() {
  const tmp = mkdtempSync(join(tmpdir(), "claude-sessions-"));
  const dbPath = join(tmp, "pipeline.db");
  const root = join(tmp, "repo");
  mkdirSync(join(root, ".git"), { recursive: true });
  const db = connectPath(dbPath);
  projectAdd(db, { name: PROJECT, rootPath: root });
  return { tmp, db };
}

function teardown(tmp, db) {
  try { close(db); } catch {}
  rmSync(tmp, { recursive: true, force: true });
}

test("upsertClaudeSession + getClaudeSession: round-trip", () => {
  const { tmp, db } = setup();
  try {
    const now = Date.now() / 1000;
    const sessionId = "test-session-1";
    const cwd = "/home/user/project";
    const summary = "Test session";

    upsertClaudeSession(db, {
      sessionId,
      cwd,
      startedAt: now,
      userTs: now,
      summary,
    });

    const retrieved = getClaudeSession(db, sessionId);
    ok(retrieved, "session retrieved");
    equal(retrieved.session_id, sessionId);
    equal(retrieved.cwd, cwd);
    equal(retrieved.summary, summary);
  } finally { teardown(tmp, db); }
});

test("listActiveClaudeSessionsByCwd: filters by cwd", () => {
  const { tmp, db } = setup();
  try {
    const now = Date.now() / 1000;
    const cwd1 = "/path/a";
    const cwd2 = "/path/b";

    upsertClaudeSession(db, {
      sessionId: "sess-a1",
      cwd: cwd1,
      startedAt: now,
      userTs: now,
      summary: null,
    });
    upsertClaudeSession(db, {
      sessionId: "sess-a2",
      cwd: cwd1,
      startedAt: now,
      userTs: now,
      summary: null,
    });
    upsertClaudeSession(db, {
      sessionId: "sess-b1",
      cwd: cwd2,
      startedAt: now,
      userTs: now,
      summary: null,
    });

    const rows1 = listActiveClaudeSessionsByCwd(db, cwd1);
    equal(rows1.length, 2);
    equal(rows1[0].cwd, cwd1);
    equal(rows1[1].cwd, cwd1);

    const rows2 = listActiveClaudeSessionsByCwd(db, cwd2);
    equal(rows2.length, 1);
    equal(rows2[0].session_id, "sess-b1");
  } finally { teardown(tmp, db); }
});

test("getLastCheckpointSize + setLastCheckpointSize: round-trip", () => {
  const { tmp, db } = setup();
  try {
    const now = Date.now() / 1000;
    const sessionId = "checkpoint-test";

    upsertClaudeSession(db, {
      sessionId,
      cwd: "/path",
      startedAt: now,
      userTs: now,
      summary: null,
    });

    const initial = getLastCheckpointSize(db, sessionId);
    equal(initial, null, "initial checkpoint size is null");

    setLastCheckpointSize(db, sessionId, 2048576);
    const updated = getLastCheckpointSize(db, sessionId);
    equal(updated, 2048576);
  } finally { teardown(tmp, db); }
});

test("listAllClaudeSessionIds: returns all ids in sorted order with no duplicates", () => {
  const { tmp, db } = setup();
  try {
    const now = Date.now() / 1000;

    upsertClaudeSession(db, {
      sessionId: "session-charlie",
      cwd: "/path1",
      startedAt: now,
      userTs: now,
      summary: null,
    });
    upsertClaudeSession(db, {
      sessionId: "session-alpha",
      cwd: "/path2",
      startedAt: now,
      userTs: now,
      summary: null,
    });
    upsertClaudeSession(db, {
      sessionId: "session-bravo",
      cwd: "/path3",
      startedAt: now,
      userTs: now,
      summary: null,
    });

    const ids = listAllClaudeSessionIds(db).sort();
    deepEqual(ids, ["session-alpha", "session-bravo", "session-charlie"]);
  } finally { teardown(tmp, db); }
});
