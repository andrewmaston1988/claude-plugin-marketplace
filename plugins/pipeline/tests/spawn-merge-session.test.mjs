// spawn-merge-session.test.mjs — verifies that spawnMerge records its session
// in the unified `sessions` table (BLOCKER 1 fix).
//
// Before the fix, the reaper's sessionsActive() reconcile could not detect a
// crashed merge session because spawnMerge never called sessionRecordSpawn.
// This test runs spawnMerge with dryRun=false against a stub `claude` binary
// (so the actual spawn succeeds without launching a real Claude) and asserts
// that the sessions table contains a row tagged session_type='merge' with the
// expected correlation_id, feature, and pid.
//
// On Windows we put a fake `claude.cmd` on PATH so `where claude` resolves to
// it. On POSIX a shell-script stub on PATH serves the same role.

import { test } from "node:test";
import { strictEqual, ok } from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, delimiter } from "node:path";
import { spawnSync } from "node:child_process";

import { connectPath, close } from "../src/db/connection.mjs";
import { projectAdd } from "../src/db/projects.mjs";
import { rowAdd, rowGet } from "../src/db/rows.mjs";
import { spawnMerge } from "../src/orchestrator/spawn.mjs";

function createMockLog() {
  const logs = [];
  const fn = (msg, level = "INFO") => { logs.push({ msg, level }); };
  fn.getLogs = () => logs;
  fn.hasMessage = (substr) => logs.some((l) => l.msg.includes(substr));
  return fn;
}

// Install a stub `claude` binary in a fresh tempdir and return that dir. The
// stub exits 0 immediately so the actual spawn() returns a quickly-resolved
// process — fast enough for `node --test` and hermetic to the real Claude CLI.
function installStubClaude() {
  const dir = mkdtempSync(join(tmpdir(), "spawn-merge-stub-"));
  if (process.platform === "win32") {
    const stub = join(dir, "claude.cmd");
    writeFileSync(stub, "@echo off\r\nexit /b 0\r\n", "utf8");
  } else {
    const stub = join(dir, "claude");
    writeFileSync(stub, "#!/bin/sh\nexit 0\n", "utf8");
    spawnSync("chmod", ["+x", stub]);
  }
  return dir;
}

test("spawnMerge: records a session row tagged session_type='merge'", () => {
  const stubDir = installStubClaude();
  const homeDir = mkdtempSync(join(tmpdir(), "spawn-merge-home-"));
  const prevHome = process.env.HOME;
  const prevUserProfile = process.env.USERPROFILE;
  const prevPath = process.env.PATH;
  const db = connectPath(join(homeDir, "pipeline.db"));
  try {
    const projectRoot = join(homeDir, "project");
    mkdirSync(projectRoot, { recursive: true });
    // projectAdd requires a real git repo at rootPath.
    spawnSync("git", ["init", "-q"], { cwd: projectRoot, windowsHide: true });
    spawnSync("git", ["config", "user.email", "t@t.com"], { cwd: projectRoot, windowsHide: true });
    spawnSync("git", ["config", "user.name",  "T"],         { cwd: projectRoot, windowsHide: true });
    writeFileSync(join(projectRoot, "README.md"), "init\n", "utf8");
    spawnSync("git", ["add", "README.md"], { cwd: projectRoot, windowsHide: true });
    spawnSync("git", ["commit", "-m", "init", "-q"], { cwd: projectRoot, windowsHide: true });
    projectAdd(db, { name: "merge-test", rootPath: projectRoot });
    rowAdd(db, "merge-test", {
      feature:       "merge-feat",
      planFile:      "plans/merge-feat.md",
      stage:         "merge",
      branch:        "autonomous/merge-feat",
      targetBranch:  "master",
    });
    const row = rowGet(db, "merge-test", "merge-feat");
    ok(row, "row should exist after rowAdd");

    // Isolate the spawn environment: stub claude on PATH, isolated homedir so
    // loadPipelineConfig and findClaude's homedir()/.local/bin resolution are
    // both scoped to a temp dir.
    process.env.HOME = homeDir;
    process.env.USERPROFILE = homeDir;
    process.env.PATH = `${stubDir}${delimiter}${prevPath || ""}`;

    const proc = spawnMerge("merge-test", row, projectRoot, "claude-haiku-4-5", {
      db,
      dryRun: false,
      logFn: createMockLog(),
    });

    ok(proc && typeof proc.pid === "number",
      `spawnMerge should return a process handle with a real pid, got: ${proc}`);

    // The (instantly-exiting) stub child releases its pid before this read;
    // query the sessions table for the merge row.
    const mergeSession = db
      .prepare(
        "SELECT * FROM sessions WHERE project = ? AND feature = ? AND session_type = ?"
      )
      .get("merge-test", "merge-feat", "merge");

    ok(mergeSession, "sessions table should contain a row for the merge session");
    strictEqual(mergeSession.session_type, "merge", "session_type should be 'merge'");
    strictEqual(mergeSession.project, "merge-test");
    strictEqual(mergeSession.feature, "merge-feat");
    strictEqual(mergeSession.pid, proc.pid, "recorded pid should match the spawned child");
    ok(mergeSession.cwd, "recorded cwd should be populated");
    ok(mergeSession.session_file, "recorded session_file should be populated");
    ok(mergeSession.correlation_id && mergeSession.correlation_id.startsWith("merge-merge-feat-"),
      `correlation_id should start with 'merge-merge-feat-', got: ${mergeSession.correlation_id}`);
    strictEqual(mergeSession.is_active, 1, "new session should be marked is_active=1");
    ok(mergeSession.spawn_time, "spawn_time should be populated");
  } finally {
    try { close(db); } catch {}
    try { rmSync(homeDir, { recursive: true, force: true, maxRetries: 3 }); } catch {}
    try { rmSync(stubDir, { recursive: true, force: true, maxRetries: 3 }); } catch {}
    if (prevHome === undefined) delete process.env.HOME; else process.env.HOME = prevHome;
    if (prevUserProfile === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = prevUserProfile;
    if (prevPath === undefined) delete process.env.PATH; else process.env.PATH = prevPath;
  }
});
