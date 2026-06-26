// orchestrator-concurrency.test.mjs — feature-scoped concurrency gate behaviour.
import { test } from "node:test";
import { strictEqual, ok } from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { connectPath, close } from "../src/db/connection.mjs";
import { projectAdd } from "../src/db/projects.mjs";
import {
  sessionRecordSpawn, countActiveSessions, sessionsActive,
  featureIsActive,
} from "../src/db/index.mjs";
import { PIPELINE_DEFAULTS } from "../src/config-defaults.mjs";
import { runDoctor } from "../src/setup/doctor.mjs";

function freshDb() {
  const root = mkdtempSync(join(tmpdir(), "orch-conc-"));
  mkdirSync(join(root, ".git"), { recursive: true });
  const db = connectPath(join(root, ".pipeline", "pipeline.db"));
  projectAdd(db, { name: "proj-a", rootPath: root });
  return { db, root };
}

// 1. featureIsActive happy path
test("featureIsActive: true for active session, false for different feature/project", () => {
  const { db, root } = freshDb();
  try {
    sessionRecordSpawn(db, {
      correlationId: "corr-1",
      project: "proj-a",
      feature: "foo",
      sessionType: "dev",
      cwd: root,
      sessionFile: "dev.md",
      pid: process.pid,
    });
    strictEqual(featureIsActive(db, "proj-a", "foo"), true,  "same project+feature → active");
    strictEqual(featureIsActive(db, "proj-a", "bar"), false, "same project, different feature → not active");
    strictEqual(featureIsActive(db, "proj-b", "foo"), false, "different project → not active");
  } finally {
    close(db);
    rmSync(root, { recursive: true });
  }
});

// 2. Feature-scoped gate: different features in same project are not blocked by each other
test("featureIsActive: different features in same project are each independent", () => {
  const { db, root } = freshDb();
  try {
    sessionRecordSpawn(db, {
      correlationId: "corr-foo",
      project: "proj-a",
      feature: "foo",
      sessionType: "dev",
      cwd: root,
      sessionFile: "dev-foo.md",
      pid: process.pid,
    });
    // 'bar' feature should not be blocked by 'foo' being active
    strictEqual(featureIsActive(db, "proj-a", "bar"), false, "bar is not blocked by foo");
    // 'foo' would be blocked
    strictEqual(featureIsActive(db, "proj-a", "foo"), true, "foo is blocked by itself");
  } finally {
    close(db);
    rmSync(root, { recursive: true });
  }
});

// 3. Feature-scoped gate: duplicate on same feature is blocked
test("featureIsActive: active session on same feature blocks a second spawn attempt", () => {
  const { db, root } = freshDb();
  try {
    sessionRecordSpawn(db, {
      correlationId: "corr-foo",
      project: "proj-a",
      feature: "foo",
      sessionType: "dev",
      cwd: root,
      sessionFile: "dev-foo.md",
      pid: process.pid,
    });
    strictEqual(featureIsActive(db, "proj-a", "foo"), true, "same feature → blocked");
  } finally {
    close(db);
    rmSync(root, { recursive: true });
  }
});

// 4. Project-scoped gate (opt-in): any active session in project blocks all features
// The orchestrator's project-scoped check queries sessionsActive(db, project) — a
// non-empty result means the whole project is blocked regardless of feature.
test("sessionsActive: any active session blocks the whole project (scope=project behaviour)", () => {
  const { db, root } = freshDb();
  try {
    sessionRecordSpawn(db, {
      correlationId: "corr-foo",
      project: "proj-a",
      feature: "foo",
      sessionType: "dev",
      cwd: root,
      sessionFile: "dev-foo.md",
      pid: process.pid,
    });
    // Project-scoped check: proj-a has an active session → whole project blocked
    ok(sessionsActive(db, "proj-a").length > 0, "proj-a has active sessions");
    // Under feature scope, a different feature in the same project is NOT blocked
    strictEqual(featureIsActive(db, "proj-a", "bar"), false, "bar not blocked under feature scope");
    // A different project is unaffected
    strictEqual(sessionsActive(db, "proj-b").length, 0, "proj-b has no active sessions");
  } finally {
    close(db);
    rmSync(root, { recursive: true });
  }
});

// 5. Global --max-concurrent cap is enforced via countActiveSessions
test("countActiveSessions: reflects all active sessions across projects", () => {
  const { db, root } = freshDb();
  try {
    strictEqual(countActiveSessions(db), 0, "starts at 0");
    sessionRecordSpawn(db, { correlationId: "c1", project: "proj-a", feature: "f1", sessionType: "dev", cwd: root, sessionFile: "s1.md", pid: process.pid });
    strictEqual(countActiveSessions(db), 1);
    sessionRecordSpawn(db, { correlationId: "c2", project: "proj-a", feature: "f2", sessionType: "dev", cwd: root, sessionFile: "s2.md", pid: process.pid });
    strictEqual(countActiveSessions(db), 2);
    sessionRecordSpawn(db, { correlationId: "c3", project: "proj-a", feature: "f3", sessionType: "dev", cwd: root, sessionFile: "s3.md", pid: process.pid });
    // At cap=3: countActiveSessions(db) >= maxConcurrent → global cap triggers
    strictEqual(countActiveSessions(db) >= 3, true, "global cap (3) reached");
  } finally {
    close(db);
    rmSync(root, { recursive: true });
  }
});

// 6. Default config values
test("PIPELINE_DEFAULTS.orch.concurrency_scope defaults to 'feature'", () => {
  strictEqual(PIPELINE_DEFAULTS.orch.concurrency_scope, "feature");
});

test("PIPELINE_DEFAULTS.orch.max_concurrent defaults to 3", () => {
  strictEqual(PIPELINE_DEFAULTS.orch.max_concurrent, 3);
});

// 7. Doctor surfaces concurrency scope
test("doctor: concurrency-scope check surfaces the configured scope", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "orch-doctor-"));
  const cfgPath = join(tmp, "config.json");
  const paths = { stateDir: join(tmp, "state"), dataDir: join(tmp, "data") };
  try {
    // Default config (no file) → scope is "feature"
    const results = await runDoctor({ paths, configPath: cfgPath });
    const check = results.find(r => r.label === "concurrency-scope");
    ok(check, "concurrency-scope check is present");
    ok(check.ok, "check passes (informational)");
    ok(check.detail.includes("feature"), "detail mentions 'feature' scope");

    // Explicit project scope
    writeFileSync(cfgPath, JSON.stringify({ orch: { concurrency_scope: "project" } }), "utf8");
    const results2 = await runDoctor({ paths, configPath: cfgPath });
    const check2 = results2.find(r => r.label === "concurrency-scope");
    ok(check2.detail.includes("project"), "detail mentions 'project' scope");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

// 8. Doctor surfaces max-concurrent cap
test("doctor: max-concurrent check surfaces the configured cap", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "orch-doctor-mc-"));
  const cfgPath = join(tmp, "config.json");
  const paths = { stateDir: join(tmp, "state"), dataDir: join(tmp, "data") };
  try {
    // Default (no config file) → cap is 3
    const results = await runDoctor({ paths, configPath: cfgPath });
    const check = results.find(r => r.label === "max-concurrent");
    ok(check, "max-concurrent check is present");
    ok(check.ok, "check passes (informational)");
    ok(check.detail.includes("3"), "detail shows default cap of 3");

    // Explicit cap of 1
    writeFileSync(cfgPath, JSON.stringify({ orch: { max_concurrent: 1 } }), "utf8");
    const results2 = await runDoctor({ paths, configPath: cfgPath });
    const check2 = results2.find(r => r.label === "max-concurrent");
    ok(check2.detail.includes("1"), "detail shows configured cap of 1");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});
