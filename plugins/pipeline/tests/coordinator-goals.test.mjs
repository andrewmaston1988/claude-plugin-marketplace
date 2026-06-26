// coordinator_goals table helpers round-trip tests
import { test } from "node:test";
import { equal, ok, deepEqual } from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import {
  connectPath, close, projectAdd,
  setCoordinatorGoal, getCoordinatorGoal, clearCoordinatorGoal,
  listCoordinatorGoals, backfillCoordinatorGoalsFromClaudeDb,
} from "../src/db/index.mjs";

const PROJECT = "testproject";

function setup() {
  const tmp = mkdtempSync(join(tmpdir(), "coordinator-goals-"));
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

test("coordinator_goals: table exists with correct schema after migration", () => {
  const { tmp, db } = setup();
  try {
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='coordinator_goals'").all();
    equal(tables.length, 1, "coordinator_goals table should exist");
    const cols = db.prepare("PRAGMA table_info(coordinator_goals)").all().map(c => c.name);
    deepEqual(cols, ["cwd", "set_at", "ttl_seconds", "reason_message", "set_by_session"]);
    const pkCol = db.prepare("PRAGMA table_info(coordinator_goals)").all().find(c => c.pk === 1);
    equal(pkCol.name, "cwd", "cwd should be PRIMARY KEY");
  } finally { teardown(tmp, db); }
});

test("setCoordinatorGoal: inserts a new row", () => {
  const { tmp, db } = setup();
  try {
    setCoordinatorGoal(db, { cwd: "/test/cwd", ttlSeconds: 600, reasonMessage: "test reason", setBySession: "sess-1" });
    const row = getCoordinatorGoal(db, "/test/cwd");
    ok(row, "row should exist");
    equal(row.cwd, "/test/cwd");
    equal(row.ttl_seconds, 600);
    equal(row.reason_message, "test reason");
    equal(row.set_by_session, "sess-1");
    ok(row.set_at > 0, "set_at should be a positive epoch");
  } finally { teardown(tmp, db); }
});

test("setCoordinatorGoal: upsert refreshes set_at and replaces fields", async () => {
  const { tmp, db } = setup();
  try {
    setCoordinatorGoal(db, { cwd: "/c", ttlSeconds: 100, reasonMessage: "first", setBySession: "s1" });
    const first = getCoordinatorGoal(db, "/c");
    const firstSetAt = first.set_at;

    // Wait a few ms so the epoch clock advances
    await new Promise((r) => setTimeout(r, 20));
    setCoordinatorGoal(db, { cwd: "/c", ttlSeconds: 999, reasonMessage: "second", setBySession: "s2" });
    const second = getCoordinatorGoal(db, "/c");
    equal(second.ttl_seconds, 999);
    equal(second.reason_message, "second");
    equal(second.set_by_session, "s2");
    ok(second.set_at >= firstSetAt, "set_at must be refreshed on re-arm");
  } finally { teardown(tmp, db); }
});

test("setCoordinatorGoal: ttl < 1 second is clamped to 1", () => {
  const { tmp, db } = setup();
  try {
    setCoordinatorGoal(db, { cwd: "/c", ttlSeconds: 0 });
    const row = getCoordinatorGoal(db, "/c");
    equal(row.ttl_seconds, 1, "ttl_seconds must be at least 1");
    setCoordinatorGoal(db, { cwd: "/c", ttlSeconds: -5 });
    const row2 = getCoordinatorGoal(db, "/c");
    equal(row2.ttl_seconds, 1, "ttl_seconds must be at least 1 even for negative input");
  } finally { teardown(tmp, db); }
});

test("setCoordinatorGoal: null reason/session fields are accepted", () => {
  const { tmp, db } = setup();
  try {
    setCoordinatorGoal(db, { cwd: "/c", ttlSeconds: 60 });
    const row = getCoordinatorGoal(db, "/c");
    equal(row.reason_message, null);
    equal(row.set_by_session, null);
  } finally { teardown(tmp, db); }
});

test("getCoordinatorGoal: returns null for missing cwd", () => {
  const { tmp, db } = setup();
  try {
    const row = getCoordinatorGoal(db, "/never/set");
    equal(row, null);
  } finally { teardown(tmp, db); }
});

test("clearCoordinatorGoal: deletes a row, returns change count", () => {
  const { tmp, db } = setup();
  try {
    setCoordinatorGoal(db, { cwd: "/c", ttlSeconds: 60 });
    equal(clearCoordinatorGoal(db, "/c"), 1, "should report 1 row deleted");
    equal(getCoordinatorGoal(db, "/c"), null, "row should be gone");
    equal(clearCoordinatorGoal(db, "/c"), 0, "second clear is a no-op");
  } finally { teardown(tmp, db); }
});

test("listCoordinatorGoals: orders by set_at desc", () => {
  const { tmp, db } = setup();
  try {
    // Backdate set_at so the ordering is deterministic regardless of ms-precision wall clock
    db.prepare("INSERT INTO coordinator_goals (cwd, set_at, ttl_seconds) VALUES (?,?,?)").run("/a", 100.0, 60);
    db.prepare("INSERT INTO coordinator_goals (cwd, set_at, ttl_seconds) VALUES (?,?,?)").run("/b", 200.0, 60);
    db.prepare("INSERT INTO coordinator_goals (cwd, set_at, ttl_seconds) VALUES (?,?,?)").run("/c", 300.0, 60);
    const rows = listCoordinatorGoals(db);
    equal(rows.length, 3);
    equal(rows[0].cwd, "/c", "newest first");
    equal(rows[2].cwd, "/a", "oldest last");
  } finally { teardown(tmp, db); }
});

test("getCoordinatorGoal: returns null for expired goals", () => {
  const { tmp, db } = setup();
  try {
    // Backdate set_at so ttl_seconds has already elapsed.
    db.prepare("INSERT INTO coordinator_goals (cwd, set_at, ttl_seconds) VALUES (?,?,?)").run("/c", Date.now() / 1000 - 10, 1);
    equal(getCoordinatorGoal(db, "/c"), null, "expired goal must return null");
  } finally { teardown(tmp, db); }
});

test("backfillCoordinatorGoalsFromClaudeDb: copies rows from claude.db fixture", () => {
  // Build a fixture claude.db with a coordinator_goals table
  const fixturePath = join(tmpdir(), `coordinator-goals-fixture-${process.pid}.db`);
  const fixtureDb = new DatabaseSync(fixturePath);
  fixtureDb.exec(`
    CREATE TABLE coordinator_goals (
      cwd TEXT PRIMARY KEY,
      set_at TEXT NOT NULL,
      ttl_seconds INTEGER NOT NULL,
      reason_message TEXT,
      set_by_session TEXT
    )
  `);
  fixtureDb.prepare("INSERT INTO coordinator_goals VALUES (?,?,?,?,?)")
    .run("/proj/a", "1718366400", 600, "A reason", "sess-a");
  fixtureDb.prepare("INSERT INTO coordinator_goals VALUES (?,?,?,?,?)")
    .run("/proj/b", "1718366500", 900, null, null);
  fixtureDb.close();

  const { tmp, db } = setup();
  try {
    backfillCoordinatorGoalsFromClaudeDb(db, fixturePath);
    // Use listCoordinatorGoals: backfilled rows may have expired TTLs and are
    // invisible to getCoordinatorGoal, but must still be present in the DB.
    const rows = listCoordinatorGoals(db);
    const a = rows.find(r => r.cwd === "/proj/a");
    ok(a, "row a should exist");
    equal(a.ttl_seconds, 600);
    equal(a.reason_message, "A reason");
    equal(a.set_by_session, "sess-a");
    equal(a.set_at, 1718366400, "set_at should be cast to REAL");

    const b = rows.find(r => r.cwd === "/proj/b");
    ok(b);
    equal(b.reason_message, null);
    equal(b.set_by_session, null);

    // Idempotent re-run
    backfillCoordinatorGoalsFromClaudeDb(db, fixturePath);
    equal(listCoordinatorGoals(db).length, 2, "re-run must not duplicate rows");
  } finally {
    teardown(tmp, db);
    try { rmSync(fixturePath, { force: true }); } catch {}
  }
});

test("backfillCoordinatorGoalsFromClaudeDb: refuses single-quote in path", () => {
  const { tmp, db } = setup();
  try {
    let threw = false;
    try { backfillCoordinatorGoalsFromClaudeDb(db, "/bad/path'/claude.db"); }
    catch (e) { threw = /single quotes/.test(e.message); }
    ok(threw, "should refuse paths containing a single quote");
  } finally { teardown(tmp, db); }
});
