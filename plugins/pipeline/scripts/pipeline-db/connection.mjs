import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { getPaths } from "../../src/paths.mjs";

// Unified schema for the single pipeline DB at <dataDir>/pipeline.db.
// All tables carry a `project` column where they would have been per-project
// in the prior topology. The `projects` table is the explicit registry; no
// filesystem scan, no claudeBase concept.
const SCHEMA_V1 = `
CREATE TABLE IF NOT EXISTS schema_version (
  version INTEGER PRIMARY KEY,
  applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS projects (
  name        TEXT PRIMARY KEY,
  root_path   TEXT NOT NULL UNIQUE,
  plans_dir   TEXT,
  enabled     INTEGER NOT NULL DEFAULT 1,
  created_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_projects_enabled ON projects(enabled);

CREATE TABLE IF NOT EXISTS pipeline_rows (
  project TEXT NOT NULL,
  feature TEXT NOT NULL,
  plan_file TEXT NOT NULL,
  stage TEXT NOT NULL,
  branch TEXT NOT NULL DEFAULT '—',
  r_model TEXT,
  d_model TEXT,
  q_model TEXT,
  r_effort TEXT DEFAULT 'high',
  d_effort TEXT DEFAULT 'medium',
  q_effort TEXT DEFAULT 'low',
  rvw_model TEXT DEFAULT 'claude-sonnet-4-6',
  session_type TEXT,
  session_file TEXT,
  budget_usd REAL,
  qa_pass INTEGER,
  dev_retries INTEGER DEFAULT 0,
  spawn_failed INTEGER DEFAULT 0,
  notes_extra TEXT,
  depends_on TEXT,
  rebase_required INTEGER DEFAULT 0,
  target_branch TEXT DEFAULT 'main',
  last_error TEXT,
  review_retries INTEGER DEFAULT 0,
  review_retry_budget INTEGER DEFAULT 3,
  review_verdict TEXT,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (project, feature)
);

CREATE INDEX IF NOT EXISTS idx_pipeline_rows_stage   ON pipeline_rows(stage);
CREATE INDEX IF NOT EXISTS idx_pipeline_rows_project ON pipeline_rows(project);

CREATE TABLE IF NOT EXISTS progress_files (
  slug TEXT PRIMARY KEY,
  project TEXT NOT NULL,
  parent_slug TEXT,
  prefix TEXT,
  pid INTEGER,
  session_type TEXT,
  is_active INTEGER DEFAULT 1,
  notes TEXT,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  completed_at TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_progress_files_active         ON progress_files(is_active);
CREATE INDEX IF NOT EXISTS idx_progress_files_project_active ON progress_files(project, is_active);
CREATE INDEX IF NOT EXISTS idx_progress_files_parent         ON progress_files(parent_slug);

CREATE TABLE IF NOT EXISTS progress_steps (
  id INTEGER PRIMARY KEY,
  slug TEXT NOT NULL,
  step_index INTEGER NOT NULL,
  content TEXT NOT NULL,
  state TEXT DEFAULT 'pending',
  FOREIGN KEY(slug) REFERENCES progress_files(slug) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_progress_steps_slug       ON progress_steps(slug);
CREATE INDEX IF NOT EXISTS idx_progress_steps_slug_state ON progress_steps(slug, state);

CREATE TABLE IF NOT EXISTS sessions (
  correlation_id TEXT PRIMARY KEY,
  session_id TEXT,
  project TEXT NOT NULL,
  feature TEXT NOT NULL,
  session_type TEXT NOT NULL,
  cwd TEXT NOT NULL,
  session_file TEXT NOT NULL,
  spawn_time TEXT NOT NULL,
  pid INTEGER,
  is_active INTEGER NOT NULL DEFAULT 1,
  finished_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_sessions_active ON sessions(project, is_active);

CREATE TABLE IF NOT EXISTS orchestrator_state (
  key TEXT PRIMARY KEY,
  value TEXT
);

CREATE TABLE IF NOT EXISTS circuit_breaker_state (
  key TEXT PRIMARY KEY,
  value TEXT
);

CREATE TABLE IF NOT EXISTS pipeline_meta (
  project TEXT NOT NULL,
  key TEXT NOT NULL,
  value TEXT NOT NULL,
  PRIMARY KEY (project, key)
);

CREATE TABLE IF NOT EXISTS metric_sessions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT UNIQUE,
  timestamp TEXT,
  command_type TEXT,
  branch TEXT,
  correlation_id TEXT,
  duration_seconds REAL,
  files_indexed INTEGER,
  plan_file TEXT,
  cache_create_tokens INTEGER,
  cache_read_tokens INTEGER,
  token_source TEXT,
  estimation_method TEXT,
  cache_read_ratio REAL,
  turn_count INTEGER
);

CREATE INDEX IF NOT EXISTS idx_metric_sessions_session ON metric_sessions(session_id);
CREATE INDEX IF NOT EXISTS idx_metric_sessions_ts      ON metric_sessions(timestamp);

CREATE TABLE IF NOT EXISTS daily_spend (
  date TEXT PRIMARY KEY,
  total_cost REAL,
  cache_create INTEGER DEFAULT 0,
  cache_read INTEGER DEFAULT 0,
  model_breakdowns TEXT
);

CREATE TABLE IF NOT EXISTS session_spawn_map (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  spawn_time TEXT,
  corr_id TEXT,
  stype TEXT,
  cwd TEXT,
  project TEXT,
  feature TEXT,
  session_id TEXT,
  parent_session_id TEXT
);

CREATE INDEX IF NOT EXISTS idx_session_spawn_corr ON session_spawn_map(corr_id);

CREATE TABLE IF NOT EXISTS governor_spawns (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  slot_hour INTEGER,
  spawn_time TEXT,
  corr_id TEXT,
  report_type TEXT
);

CREATE TABLE IF NOT EXISTS cycle_log (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  project         TEXT NOT NULL,
  feature         TEXT NOT NULL,
  stage           TEXT NOT NULL,
  correlation_id  TEXT,
  start_time      TEXT NOT NULL,
  end_time        TEXT NOT NULL,
  duration_secs   REAL,
  spend_tokens    INTEGER,
  outcome         TEXT CHECK(outcome IN ('pass','fail','retry'))
);

CREATE INDEX IF NOT EXISTS idx_cycle_log_project_feature ON cycle_log(project, feature);
CREATE INDEX IF NOT EXISTS idx_cycle_log_stage           ON cycle_log(stage);
CREATE INDEX IF NOT EXISTS idx_cycle_log_end_time        ON cycle_log(end_time);

INSERT OR IGNORE INTO schema_version (version) VALUES (1);
`;

// V2 — ensures `cycle_log` exists on DBs that were bootstrapped before the
// table was added to SCHEMA_V1. The CREATE/INDEX statements are also in V1
// (for fresh installs); both are `IF NOT EXISTS` so re-running is a no-op.
const SCHEMA_V2 = `
CREATE TABLE IF NOT EXISTS cycle_log (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  project         TEXT NOT NULL,
  feature         TEXT NOT NULL,
  stage           TEXT NOT NULL,
  correlation_id  TEXT,
  start_time      TEXT NOT NULL,
  end_time        TEXT NOT NULL,
  duration_secs   REAL,
  spend_tokens    INTEGER,
  outcome         TEXT CHECK(outcome IN ('pass','fail','retry'))
);
CREATE INDEX IF NOT EXISTS idx_cycle_log_project_feature ON cycle_log(project, feature);
CREATE INDEX IF NOT EXISTS idx_cycle_log_stage           ON cycle_log(stage);
CREATE INDEX IF NOT EXISTS idx_cycle_log_end_time        ON cycle_log(end_time);
INSERT OR IGNORE INTO schema_version (version) VALUES (2);
`;

const SCHEMA_V3 = `
ALTER TABLE pipeline_rows ADD COLUMN pr_title TEXT;
INSERT OR IGNORE INTO schema_version (version) VALUES (3);
`;

// waits_on: feature slug of a prerequisite row this one chains behind (the
// orchestrator gates the spawn until that row is done AND its branch is an
// ancestor of the target). base_branch: the branch a fresh feature worktree
// is created from (default: target_branch) — lets a dependent branch off its
// prerequisite's autonomous branch so it sees that code before it merges.
const SCHEMA_V4_VERSION = 4;

const SCHEMA_V5 = `
CREATE TABLE IF NOT EXISTS plans (
  project     TEXT NOT NULL,
  slug        TEXT NOT NULL,
  file_path   TEXT NOT NULL,
  status      TEXT NOT NULL DEFAULT 'active',
  branch      TEXT,
  title       TEXT,
  body        TEXT,
  indexed_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (project, slug)
);
CREATE INDEX IF NOT EXISTS idx_plans_project ON plans(project);
CREATE INDEX IF NOT EXISTS idx_plans_status  ON plans(status);

CREATE VIRTUAL TABLE IF NOT EXISTS plans_fts USING fts5(
  slug, title, body,
  content='plans',
  content_rowid='rowid',
  tokenize='unicode61'
);

INSERT OR IGNORE INTO schema_version(version) VALUES(5);
`;

// Add effort columns: r_effort, d_effort, q_effort with role-appropriate defaults
// ('high' for review, 'medium' for dev, 'low' for queue)
const SCHEMA_V6_VERSION = 6;

// Add claude_sessions table for absorbing claude.db.claude_sessions into pipeline.db
// Schema mirrors claude.db.claude_sessions exactly:
// - session_id TEXT PRIMARY KEY
// - cwd TEXT NOT NULL
// - started_at REAL NOT NULL (unix epoch seconds)
// - user_ts REAL NOT NULL (last user-prompt timestamp, not updated by keepalive)
// - summary TEXT (peer-visible summary)
const SCHEMA_V7_VERSION = 7;

const SCHEMA_V7 = `
CREATE TABLE IF NOT EXISTS claude_sessions (
  session_id TEXT PRIMARY KEY,
  cwd TEXT NOT NULL,
  started_at REAL NOT NULL,
  user_ts REAL NOT NULL,
  summary TEXT
);
CREATE INDEX IF NOT EXISTS idx_claude_sessions_cwd ON claude_sessions(cwd);
INSERT OR IGNORE INTO schema_version (version) VALUES (7);
`;

function _applyMigrations(db) {
  let currentVersion = 0;
  try {
    const row = db.prepare("SELECT MAX(version) AS v FROM schema_version").get();
    currentVersion = (row && row.v != null) ? row.v : 0;
  } catch {
    currentVersion = 0;
  }

  if (currentVersion < 1) {
    db.exec(SCHEMA_V1);
  }
  if (currentVersion < 2) {
    db.exec(SCHEMA_V2);
  }
  if (currentVersion < 3) {
    // Add pr_title column — ALTER TABLE ADD COLUMN is safe on existing data.
    const cols = db.prepare("PRAGMA table_info(pipeline_rows)").all().map(c => c.name);
    if (!cols.includes("pr_title")) {
      db.exec("ALTER TABLE pipeline_rows ADD COLUMN pr_title TEXT");
    }
    db.exec("INSERT OR IGNORE INTO schema_version (version) VALUES (3)");
  }
  if (currentVersion < SCHEMA_V4_VERSION) {
    // Add waits_on + base_branch — plan-base-branch-chaining. Idempotent
    // guards so a partially-migrated DB doesn't throw on the second column.
    const cols = db.prepare("PRAGMA table_info(pipeline_rows)").all().map(c => c.name);
    if (!cols.includes("waits_on")) {
      db.exec("ALTER TABLE pipeline_rows ADD COLUMN waits_on TEXT");
    }
    if (!cols.includes("base_branch")) {
      db.exec("ALTER TABLE pipeline_rows ADD COLUMN base_branch TEXT");
    }
    db.exec(`INSERT OR IGNORE INTO schema_version (version) VALUES (${SCHEMA_V4_VERSION})`);
  }
  if (currentVersion < 5) {
    db.exec(SCHEMA_V5);
  }
  if (currentVersion < SCHEMA_V6_VERSION) {
    // Add effort columns: r_effort, d_effort, q_effort for pipeline effort dimension
    const cols = db.prepare("PRAGMA table_info(pipeline_rows)").all().map(c => c.name);
    if (!cols.includes("r_effort")) {
      db.exec("ALTER TABLE pipeline_rows ADD COLUMN r_effort TEXT DEFAULT 'high'");
    }
    if (!cols.includes("d_effort")) {
      db.exec("ALTER TABLE pipeline_rows ADD COLUMN d_effort TEXT DEFAULT 'medium'");
    }
    if (!cols.includes("q_effort")) {
      db.exec("ALTER TABLE pipeline_rows ADD COLUMN q_effort TEXT DEFAULT 'low'");
    }
    db.exec(`INSERT OR IGNORE INTO schema_version (version) VALUES (${SCHEMA_V6_VERSION})`);
  }
  if (currentVersion < SCHEMA_V7_VERSION) {
    db.exec(SCHEMA_V7);
  }
}

// Resolve the unified DB path under the plugin's data directory.
// All callers go through this — there is one DB per machine.
export function dbPathUnified(paths = getPaths()) {
  return join(paths.dataDir, "pipeline.db");
}

// Open the unified DB. Creates parent dir on demand, enables WAL, runs schema.
export function connectUnified(paths = getPaths()) {
  const path = dbPathUnified(paths);
  mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode=WAL");
  db.exec("PRAGMA foreign_keys=ON");
  _applyMigrations(db);
  return db;
}

// Test-only helper: open an arbitrary DB path or :memory: with the full schema.
// Production callers must use connectUnified().
export function connectPath(dbFile) {
  const path = String(dbFile);
  if (path !== ":memory:") {
    mkdirSync(dirname(path), { recursive: true });
  }
  const db = new DatabaseSync(path);
  if (path !== ":memory:") {
    db.exec("PRAGMA journal_mode=WAL");
  }
  db.exec("PRAGMA foreign_keys=ON");
  _applyMigrations(db);
  return db;
}

export function close(db) {
  db.close();
}
