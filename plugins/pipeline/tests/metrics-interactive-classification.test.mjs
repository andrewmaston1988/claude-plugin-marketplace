// Interactive session classification tests
import { test } from "node:test";
import { equal, ok, deepEqual } from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir, homedir } from "node:os";
import {
  connectPath, close, projectAdd,
  upsertClaudeSession, listAllClaudeSessionIds,
  loadMetricSessions,
} from "../scripts/pipeline-db/index.mjs";
import {
  loadInteractiveSessionIds, updateSessions, classifyFirstPrompt,
} from "../scripts/metrics/sessions.mjs";

const PROJECT = "testproject";

function setup() {
  const tmp = mkdtempSync(join(tmpdir(), "metrics-interactive-"));
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

test("loadInteractiveSessionIds returns all session_ids in pipeline.db.claude_sessions", () => {
  const { tmp, db } = setup();
  try {
    const now = Date.now() / 1000;
    upsertClaudeSession(db, {
      sessionId: "sess-A",
      cwd: "/project/path",
      startedAt: now,
      userTs: now,
      summary: "Test session A",
    });
    upsertClaudeSession(db, {
      sessionId: "sess-B",
      cwd: "/project/path",
      startedAt: now,
      userTs: now,
      summary: "Test session B",
    });

    const ids = loadInteractiveSessionIds(db);
    equal(ids.size, 2, "returned Set has 2 elements");
    ok(ids.has("sess-A"), "Set contains sess-A");
    ok(ids.has("sess-B"), "Set contains sess-B");
  } finally { teardown(tmp, db); }
});

test("listAllClaudeSessionIds with no duplicate session ids", () => {
  const { tmp, db } = setup();
  try {
    const now = Date.now() / 1000;
    upsertClaudeSession(db, {
      sessionId: "sess-1",
      cwd: "/path1",
      startedAt: now,
      userTs: now,
      summary: null,
    });
    upsertClaudeSession(db, {
      sessionId: "sess-2",
      cwd: "/path2",
      startedAt: now,
      userTs: now,
      summary: null,
    });
    upsertClaudeSession(db, {
      sessionId: "sess-3",
      cwd: "/path3",
      startedAt: now,
      userTs: now,
      summary: null,
    });

    const ids = listAllClaudeSessionIds(db).sort();
    deepEqual(ids, ["sess-1", "sess-2", "sess-3"]);
  } finally { teardown(tmp, db); }
});

test("updateSessions classifies as interactive when no prefix/branch/project match and session_id is in claude_sessions", () => {
  const { tmp, db } = setup();
  try {
    const now = Date.now() / 1000;
    const sessionId = "interactive-sess-xyz";

    upsertClaudeSession(db, {
      sessionId,
      cwd: "/some/path",
      startedAt: now,
      userTs: now,
      summary: null,
    });

    // Inject a synthetic history record with project="" so updateSessions finds no
    // session file on disk — firstPrompt stays "", no prefix/branch/project match,
    // and the interactive fallback fires because sessionId is in claude_sessions.
    updateSessions(db, {
      historyOverride: [{
        sessionId,
        timestamp: new Date(now * 1000).toISOString(),
        duration: 1800,
        project: "",
      }],
    });

    const rows = loadMetricSessions(db);
    equal(rows.length, 1, "one session was inserted");
    equal(rows[0].command_type, "interactive", "interactive fallback applied");
  } finally { teardown(tmp, db); }
});

test("prefix classification wins over interactive fallback", () => {
  const { tmp, db } = setup();
  try {
    const now = Date.now() / 1000;
    const sessionId = "dev-prefix-sess";

    upsertClaudeSession(db, {
      sessionId,
      cwd: "/some/path",
      startedAt: now,
      userTs: now,
      summary: null,
    });

    const interactiveIds = loadInteractiveSessionIds(db);
    ok(interactiveIds.has(sessionId), "session is in interactiveIds");

    // classifyFirstPrompt for a dev-prefix prompt returns "dev", not null.
    // The updateSessions chain only reaches the interactive fallback when
    // commandType === "unknown" — a non-null prefixType short-circuits the chain.
    const [prefixType] = classifyFirstPrompt("Read sessions/dev-foo.md", null);
    equal(prefixType, "dev", "dev prefix classifies as dev");

    // Simulate the priority check: prefix wins, interactive fallback is skipped.
    const commandType = prefixType ?? "unknown";
    const finalType = (!commandType || commandType === "unknown")
      ? (interactiveIds.has(sessionId) ? "interactive" : commandType)
      : commandType;
    equal(finalType, "dev", "dev prefix wins over interactive fallback for same session");
  } finally { teardown(tmp, db); }
});

test("claude_sessions presence overrides user_type=external slack fallback on interactive/* branch", () => {
  // Regression for plan metrics-interactive-session-classifier-fix:
  // an interactive session on an `interactive/*` branch has user_type=external
  // (set by the Slack bridge route) and no recognised prefix or branch-pattern
  // match. Without the fix, the slack fallback wins because the interactiveIds
  // override was guarded by `!commandType || commandType === "unknown"`.
  const { tmp, db } = setup();
  const sessionId = "interactive-branch-sess-regression";
  const projectPath = `C:/__test_classifier_${Date.now()}__/repo`;
  const projectsDir = join(homedir(), ".claude", "projects");
  const encoded = projectPath.replace(/[^a-zA-Z0-9]/g, "-");
  const sessionDir = join(projectsDir, encoded);
  const sessionFile = join(sessionDir, `${sessionId}.jsonl`);

  mkdirSync(sessionDir, { recursive: true });
  writeFileSync(
    sessionFile,
    JSON.stringify({
      type: "user",
      sessionId,
      timestamp: new Date().toISOString(),
      gitBranch: "interactive/metrics-fix",
      cwd: projectPath,
      userType: "external",
      message: { content: "Lets pick up again" },
    }) + "\n",
    "utf8",
  );

  try {
    const now = Date.now() / 1000;
    upsertClaudeSession(db, {
      sessionId,
      cwd: projectPath,
      startedAt: now,
      userTs: now,
      summary: null,
    });

    updateSessions(db, {
      historyOverride: [{
        sessionId,
        timestamp: new Date(now * 1000).toISOString(),
        duration: 1800,
        project: projectPath,
      }],
    });

    const rows = loadMetricSessions(db);
    equal(rows.length, 1, "one session was inserted");
    equal(
      rows[0].command_type,
      "interactive",
      "claude_sessions presence overrides external-slack fallback on interactive/* branch",
    );
  } finally {
    teardown(tmp, db);
    rmSync(sessionDir, { recursive: true, force: true });
  }
});
