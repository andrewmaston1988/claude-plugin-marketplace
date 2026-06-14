import { test } from "node:test";
import { strict as assert } from "node:assert";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { unlinkSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { connectPath } from "./connection.mjs";
import {
  upsertClaudeSession,
  getClaudeSession,
  listActiveClaudeSessionsByCwd,
  backfillFromClaudeDb,
} from "./claude-sessions.mjs";

test("claude_sessions table migration creates table with correct schema", (t) => {
  const db = connectPath(":memory:");

  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='claude_sessions'").all();
  assert.equal(tables.length, 1, "claude_sessions table should exist");

  const cols = db.prepare("PRAGMA table_info(claude_sessions)").all();
  const colNames = cols.map(c => c.name);
  assert.deepEqual(
    colNames,
    ["session_id", "cwd", "started_at", "user_ts", "summary"],
    "Should have exactly 5 columns in order"
  );

  const pkCol = cols.find(c => c.pk === 1);
  assert.equal(pkCol.name, "session_id", "session_id should be PRIMARY KEY");

  db.close();
});

test("migration is idempotent on the same connection", (t) => {
  const db = connectPath(":memory:");

  upsertClaudeSession(db, {
    sessionId: "test-idem",
    cwd: "/test",
    startedAt: 1000.0,
    userTs: 2000.0,
    summary: "Test",
  });

  // Re-run the V7 DDL on the same already-migrated DB — must not throw or corrupt
  assert.doesNotThrow(() => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS claude_sessions (
        session_id TEXT PRIMARY KEY,
        cwd TEXT NOT NULL,
        started_at REAL NOT NULL,
        user_ts REAL NOT NULL,
        summary TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_claude_sessions_cwd ON claude_sessions(cwd);
    `);
  });

  const count = db.prepare("SELECT COUNT(*) as c FROM claude_sessions").get().c;
  assert.equal(count, 1, "Existing rows must survive idempotent re-run");

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

test("upsertClaudeSession updates cwd/user_ts/summary but preserves started_at", (t) => {
  const db = connectPath(":memory:");

  upsertClaudeSession(db, {
    sessionId: "test-2",
    cwd: "/path/1",
    startedAt: 1000.0,
    userTs: 2000.0,
    summary: "Original",
  });

  // Pass a different startedAt — must be ignored on conflict
  upsertClaudeSession(db, {
    sessionId: "test-2",
    cwd: "/path/2",
    startedAt: 9999.0,
    userTs: 3000.0,
    summary: "Updated",
  });

  const row = db.prepare("SELECT * FROM claude_sessions WHERE session_id = 'test-2'").get();
  assert.equal(row.cwd, "/path/2", "cwd should be updated");
  assert.equal(row.user_ts, 3000.0, "user_ts should be updated");
  assert.equal(row.summary, "Updated", "summary should be updated");
  assert.equal(row.started_at, 1000.0, "started_at must not be overwritten");

  db.close();
});

test("getClaudeSession returns row or null", (t) => {
  const db = connectPath(":memory:");

  const missing = getClaudeSession(db, "nonexistent");
  assert.equal(missing, null, "Should return null for missing session");

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

  upsertClaudeSession(db, { sessionId: "s1", cwd: "/home/alice", startedAt: 1000.0, userTs: 2000.0, summary: "Alice 1" });
  upsertClaudeSession(db, { sessionId: "s2", cwd: "/home/alice", startedAt: 3000.0, userTs: 4000.0, summary: "Alice 2" });
  upsertClaudeSession(db, { sessionId: "s3", cwd: "/home/bob",   startedAt: 5000.0, userTs: 6000.0, summary: "Bob 1" });

  const aliceSessions = listActiveClaudeSessionsByCwd(db, "/home/alice");
  assert.equal(aliceSessions.length, 2, "Should find 2 Alice sessions");
  assert(aliceSessions.every(s => s.cwd === "/home/alice"));

  const bobSessions = listActiveClaudeSessionsByCwd(db, "/home/bob");
  assert.equal(bobSessions.length, 1, "Should find 1 Bob session");
  assert.equal(bobSessions[0].session_id, "s3");

  const noneSessions = listActiveClaudeSessionsByCwd(db, "/home/charlie");
  assert.equal(noneSessions.length, 0, "Should find 0 sessions");

  db.close();
});

test("backfillFromClaudeDb copies rows preserving started_at, safe to re-run", (t) => {
  // Build a fixture claude.db with the claude_sessions table
  const fixturePath = join(tmpdir(), `claude-sessions-fixture-${process.pid}.db`);
  const fixtureDb = new DatabaseSync(fixturePath);
  fixtureDb.exec(`
    CREATE TABLE claude_sessions (
      session_id TEXT PRIMARY KEY,
      cwd TEXT NOT NULL,
      started_at REAL NOT NULL,
      user_ts REAL NOT NULL,
      summary TEXT
    )
  `);
  fixtureDb.prepare("INSERT INTO claude_sessions VALUES (?,?,?,?,?)").run("bf-1", "/proj/a", 100.0, 200.0, "Backfill A");
  fixtureDb.prepare("INSERT INTO claude_sessions VALUES (?,?,?,?,?)").run("bf-2", "/proj/b", 300.0, 400.0, "Backfill B");
  fixtureDb.close();

  try {
    const db = connectPath(":memory:");

    // First run
    backfillFromClaudeDb(db, fixturePath);
    const rows = db.prepare("SELECT * FROM claude_sessions ORDER BY session_id").all();
    assert.equal(rows.length, 2, "Should have 2 rows after backfill");
    assert.equal(rows[0].session_id, "bf-1");
    assert.equal(rows[0].started_at, 100.0, "started_at must be preserved");
    assert.equal(rows[1].session_id, "bf-2");

    // Idempotent re-run — should not duplicate or change rows
    backfillFromClaudeDb(db, fixturePath);
    const rowsAfter = db.prepare("SELECT COUNT(*) as c FROM claude_sessions").get().c;
    assert.equal(rowsAfter, 2, "Re-run must not duplicate rows");

    db.close();
  } finally {
    unlinkSync(fixturePath);
  }
});

test("backfillFromClaudeDb throws on path containing single quote", (t) => {
  const db = connectPath(":memory:");
  assert.throws(
    () => backfillFromClaudeDb(db, "/path/with'quote/claude.db"),
    /must not contain single quotes/
  );
  db.close();
});
