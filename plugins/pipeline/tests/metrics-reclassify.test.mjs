// Tests for the reclassify port — verifies that pipeline.db.metric_sessions
// command_type values are re-classified by current logic (port of
// cache_metrics.py::reclassify_historical).
import { test } from "node:test";
import { equal, ok } from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  connectPath, close, projectAdd,
  upsertClaudeSession,
  appendMetricSession, loadMetricSessions,
} from "../src/db/index.mjs";
import { reclassifyHistorical } from "../src/metrics/reclassify.mjs";

const PROJECT = "testproject";

function setup() {
  const tmp = mkdtempSync(join(tmpdir(), "metrics-reclassify-"));
  const dbPath = join(tmp, "pipeline.db");
  const root = join(tmp, "repo");
  // One subdir per session — matches the real ~/.claude/projects/<hash>/<sid>.jsonl
  // layout. The exact subdir name doesn't matter; the index keys off the .jsonl stem.
  const projA = join(tmp, "projects", "projA");
  const projB = join(tmp, "projects", "projB");
  const projC = join(tmp, "projects", "projC");
  mkdirSync(join(root, ".git"), { recursive: true });
  mkdirSync(projA, { recursive: true });
  mkdirSync(projB, { recursive: true });
  mkdirSync(projC, { recursive: true });
  writeFileSync(join(projA, "sess-A.jsonl"), "");
  writeFileSync(join(projB, "sess-B.jsonl"), "");
  writeFileSync(join(projC, "sess-C.jsonl"), "");
  const db = connectPath(dbPath);
  projectAdd(db, { name: PROJECT, rootPath: root });
  return { tmp, db, projectsDir: join(tmp, "projects") };
}

function teardown(tmp, db) {
  try { close(db); } catch {}
  rmSync(tmp, { recursive: true, force: true });
}

// Stub readSessionFull — same DI factory pattern as merge-pr-aware.
function readSessionFullStub(overrides) {
  return (filePath) => {
    // key off the file path stem (the session_id)
    const sid = filePath.split(/[\\/]/).pop().replace(/\.jsonl$/, "");
    const rec = overrides[sid];
    return rec ?? null;
  };
}

function insertTestRows(db) {
  // Three sessions, all initially classified as "slack" (stale).
  // Two of them are real interactive sessions (have claude_sessions entries);
  // the third is a genuine Slack session.
  for (const sid of ["sess-A", "sess-B", "sess-C"]) {
    appendMetricSession(db, {
      session_id: sid,
      timestamp: "2026-06-15T12:00:00Z",
      command_type: "slack",
      branch: "autonomous/test",
      correlation_id: null,
      duration_seconds: 100,
      files_indexed: 1,
      plan_file: null,
      cache_create_tokens: 0,
      cache_read_tokens: 0,
      token_source: "session_jsonl",
      estimation_method: "actual",
      cache_read_ratio: 0,
      turn_count: 1,
    });
  }
}

test("reclassifyHistorical: dry-run reports changes without modifying rows", () => {
  const { tmp, db, projectsDir } = setup();
  try {
    const now = Date.now() / 1000;
    upsertClaudeSession(db, { sessionId: "sess-A", cwd: "/p", startedAt: now, userTs: now, summary: null });
    upsertClaudeSession(db, { sessionId: "sess-B", cwd: "/p", startedAt: now, userTs: now, summary: null });
    insertTestRows(db);

    // Stub: all three sessions read as slack-eligible (user_type=external).
    // sess-A and sess-B will be reclassified to "interactive" via claude_sessions
    // (the unconditional win). sess-C has no claude_sessions entry, no prefix
    // match, no branch match — its user_type=external fallback to "slack" is a
    // no-op (already slack).
    const stub = readSessionFullStub({
      "sess-A": { first_prompt: "free-text prompt A", git_branch: "autonomous/test", cwd: "/p", user_type: "external" },
      "sess-B": { first_prompt: "free-text prompt B", git_branch: "autonomous/test", cwd: "/p", user_type: "external" },
      "sess-C": { first_prompt: "free-text prompt C", git_branch: "autonomous/test", cwd: "/p", user_type: "external" },
    });

    reclassifyHistorical(db, { dryRun: true, deps: { readSessionFull: stub, projectsDir } });

    const rows = loadMetricSessions(db);
    equal(rows.length, 3);
    for (const r of rows) {
      equal(r.command_type, "slack", `dry-run must not modify ${r.session_id}`);
    }
  } finally { teardown(tmp, db); }
});

test("reclassifyHistorical: applies changes — interactive sessions win, branch-derived dev stays", () => {
  const { tmp, db, projectsDir } = setup();
  try {
    const now = Date.now() / 1000;
    upsertClaudeSession(db, { sessionId: "sess-A", cwd: "/p", startedAt: now, userTs: now, summary: null });
    upsertClaudeSession(db, { sessionId: "sess-B", cwd: "/p", startedAt: now, userTs: now, summary: null });
    insertTestRows(db);

    // All three sessions are read with first_prompt that doesn't match any prefix.
    // git_branch "autonomous/test" makes extractCommandTypeFromBranch → "dev".
    // sess-A and sess-B are also in claude_sessions, so they get reclassified to "interactive"
    // (the unconditional override). sess-C has no claude_sessions entry, so it stays "dev".
    const stub = readSessionFullStub({
      "sess-A": { first_prompt: "free-text prompt A", git_branch: "autonomous/test", cwd: "/p", user_type: "external" },
      "sess-B": { first_prompt: "free-text prompt B", git_branch: "autonomous/test", cwd: "/p", user_type: "external" },
      "sess-C": { first_prompt: "free-text prompt C", git_branch: "autonomous/test", cwd: "/p", user_type: "external" },
    });

    reclassifyHistorical(db, { deps: { readSessionFull: stub, projectsDir } });

    const byId = Object.fromEntries(loadMetricSessions(db).map(r => [r.session_id, r]));
    equal(byId["sess-A"].command_type, "interactive", "sess-A → interactive (claude_sessions wins)");
    equal(byId["sess-B"].command_type, "interactive", "sess-B → interactive (claude_sessions wins)");
    equal(byId["sess-C"].command_type, "dev",        "sess-C → dev (branch prefix, no claude_sessions override)");
  } finally { teardown(tmp, db); }
});

test("reclassifyHistorical: skips rows whose session_id has no JSONL", () => {
  const tmp = mkdtempSync(join(tmpdir(), "metrics-reclassify-"));
  const dbPath = join(tmp, "pipeline.db");
  const root = join(tmp, "repo");
  const emptyProjectsDir = join(tmp, "empty-projects");
  mkdirSync(join(root, ".git"), { recursive: true });
  mkdirSync(emptyProjectsDir, { recursive: true });
  const db = connectPath(dbPath);
  projectAdd(db, { name: PROJECT, rootPath: root });
  try {
    insertTestRows(db);

    const stub = readSessionFullStub({}); // empty stub → null for everyone
    reclassifyHistorical(db, { deps: { readSessionFull: stub, projectsDir: emptyProjectsDir } });

    const rows = loadMetricSessions(db);
    equal(rows.length, 3);
    for (const r of rows) {
      equal(r.command_type, "slack", `unreadable ${r.session_id} must remain unchanged`);
    }
  } finally {
    try { close(db); } catch {}
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("reclassifyHistorical: prefix-classified session keeps its type unless claude_sessions overrides", () => {
  const tmp = mkdtempSync(join(tmpdir(), "metrics-reclassify-"));
  const dbPath = join(tmp, "pipeline.db");
  const root = join(tmp, "repo");
  const projD = join(tmp, "projects", "projD");
  mkdirSync(join(root, ".git"), { recursive: true });
  mkdirSync(projD, { recursive: true });
  writeFileSync(join(projD, "sess-D.jsonl"), "");
  const db = connectPath(dbPath);
  projectAdd(db, { name: PROJECT, rootPath: root });
  try {
    const now = Date.now() / 1000;
    upsertClaudeSession(db, { sessionId: "sess-D", cwd: "/p", startedAt: now, userTs: now, summary: null });
    // sess-D starts as "slack" but its first_prompt matches a built-in dev prefix.
    appendMetricSession(db, {
      session_id: "sess-D",
      timestamp: "2026-06-15T12:00:00Z",
      command_type: "slack",
      branch: "autonomous/test",
      correlation_id: null,
      duration_seconds: 100,
      files_indexed: 1,
      plan_file: null,
      cache_create_tokens: 0,
      cache_read_tokens: 0,
      token_source: "session_jsonl",
      estimation_method: "actual",
      cache_read_ratio: 0,
      turn_count: 1,
    });

    // First prompt with a built-in dev prefix → classifies as "dev".
    // claude_sessions entry then overrides to "interactive".
    const stub = readSessionFullStub({
      "sess-D": { first_prompt: "Read sessions/dev-2026-06-15-foo.md in full...", git_branch: "autonomous/test", cwd: "/p", user_type: "human" },
    });
    reclassifyHistorical(db, { deps: { readSessionFull: stub, projectsDir: join(tmp, "projects") } });

    const byId = Object.fromEntries(loadMetricSessions(db).map(r => [r.session_id, r]));
    equal(byId["sess-D"].command_type, "interactive", "claude_sessions overrides prefix classifier");
  } finally {
    try { close(db); } catch {}
    rmSync(tmp, { recursive: true, force: true });
  }
});
