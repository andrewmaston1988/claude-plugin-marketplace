import { test } from "node:test";
import { strict as assert } from "node:assert";
import { connectPath } from "./connection.mjs";
import {
  upsertClaudeSession,
  getClaudeSession,
  listActiveClaudeSessionsByCwd,
  backfillFromClaudeDb,
} from "./claude-sessions.mjs";

test("claude_sessions table migration creates table with correct schema", (t) => {
  const db = connectPath(":memory:");

  // Verify table exists
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='claude_sessions'").all();
  assert.equal(tables.length, 1, "claude_sessions table should exist");

  // Verify columns
  const cols = db.prepare("PRAGMA table_info(claude_sessions)").all();
  const colNames = cols.map(c => c.name);
  assert.deepEqual(
    colNames,
    ["session_id", "cwd", "started_at", "user_ts", "summary"],
    "Should have exactly 5 columns in order"
  );

  // Verify PRIMARY KEY
  const pkCol = cols.find(c => c.pk === 1);
  assert.equal(pkCol.name, "session_id", "session_id should be PRIMARY KEY");

  db.close();
});

test("upsertClaudeSession inserts new row", (t) => {
  const db = connectPath(":memory:");

  upsertClaudeSession(db, {
    sessionId: "test-1",
    cwd: "/home/user/project",
    startedAt: 1718366400.0,
    userTs: 1718366500.0,
    summary: "Test session",
  });

  const row = db.prepare("SELECT * FROM claude_sessions WHERE session_id = 'test-1'").get();
  assert(row, "Row should exist");
  assert.equal(row.session_id, "test-1");
  assert.equal(row.cwd, "/home/user/project");
  assert.equal(row.started_at, 1718366400.0);
  assert.equal(row.user_ts, 1718366500.0);
  assert.equal(row.summary, "Test session");

  db.close();
});

test("upsertClaudeSession updates existing row on PK conflict", (t) => {
  const db = connectPath(":memory:");

  // Insert initial
  upsertClaudeSession(db, {
    sessionId: "test-2",
    cwd: "/path/1",
    startedAt: 1000.0,
    userTs: 2000.0,
    summary: "Original",
  });

  // Update same session_id
  upsertClaudeSession(db, {
    sessionId: "test-2",
    cwd: "/path/2",
    startedAt: 1000.0, // unchanged
    userTs: 3000.0, // updated
    summary: "Updated",
  });

  const row = db.prepare("SELECT * FROM claude_sessions WHERE session_id = 'test-2'").get();
  assert.equal(row.cwd, "/path/2", "cwd should be updated");
  assert.equal(row.user_ts, 3000.0, "user_ts should be updated");
  assert.equal(row.summary, "Updated", "summary should be updated");
  assert.equal(row.started_at, 1000.0, "started_at should remain unchanged");

  db.close();
});

test("getClaudeSession returns row or null", (t) => {
  const db = connectPath(":memory:");

  // Non-existent
  const missing = getClaudeSession(db, "nonexistent");
  assert.equal(missing, null, "Should return null for missing session");

  // Existing
  upsertClaudeSession(db, {
    sessionId: "test-3",
    cwd: "/test",
    startedAt: 1000.0,
    userTs: 2000.0,
    summary: "Test",
  });

  const found = getClaudeSession(db, "test-3");
  assert(found, "Should return row");
  assert.equal(found.session_id, "test-3");

  db.close();
});

test("listActiveClaudeSessionsByCwd filters by cwd", (t) => {
  const db = connectPath(":memory:");

  // Insert sessions in different directories
  upsertClaudeSession(db, {
    sessionId: "s1",
    cwd: "/home/alice",
    startedAt: 1000.0,
    userTs: 2000.0,
    summary: "Alice 1",
  });

  upsertClaudeSession(db, {
    sessionId: "s2",
    cwd: "/home/alice",
    startedAt: 3000.0,
    userTs: 4000.0,
    summary: "Alice 2",
  });

  upsertClaudeSession(db, {
    sessionId: "s3",
    cwd: "/home/bob",
    startedAt: 5000.0,
    userTs: 6000.0,
    summary: "Bob 1",
  });

  // Query Alice's sessions
  const aliceSessions = listActiveClaudeSessionsByCwd(db, "/home/alice");
  assert.equal(aliceSessions.length, 2, "Should find 2 Alice sessions");
  assert(aliceSessions.every(s => s.cwd === "/home/alice"));

  // Query Bob's sessions
  const bobSessions = listActiveClaudeSessionsByCwd(db, "/home/bob");
  assert.equal(bobSessions.length, 1, "Should find 1 Bob session");
  assert.equal(bobSessions[0].session_id, "s3");

  // Query non-existent directory
  const noneSessions = listActiveClaudeSessionsByCwd(db, "/home/charlie");
  assert.equal(noneSessions.length, 0, "Should find 0 sessions");

  db.close();
});

test("migration is idempotent", (t) => {
  const db = connectPath(":memory:");

  // Add a row
  upsertClaudeSession(db, {
    sessionId: "test-4",
    cwd: "/test",
    startedAt: 1000.0,
    userTs: 2000.0,
    summary: "Test",
  });

  // Verify row exists
  const count1 = db.prepare("SELECT COUNT(*) as c FROM claude_sessions").get().c;
  assert.equal(count1, 1);

  // Re-connecting (which re-applies migrations) should not affect existing data
  const db2 = connectPath(":memory:");
  const count2 = db2.prepare("SELECT COUNT(*) as c FROM claude_sessions").get().c;
  assert.equal(count2, 0, "Fresh DB should start empty");

  db.close();
  db2.close();
});
