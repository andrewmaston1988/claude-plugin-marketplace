import { test } from "node:test";
import { strictEqual, ok, match } from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { connectPath, close } from "../scripts/pipeline-db/connection.mjs";
import { projectAdd } from "../scripts/pipeline-db/projects.mjs";
import { rowAdd, rowUpdate } from "../scripts/pipeline-db/rows.mjs";

test("orchestrator stage-driven spawn: dev stage row", () => {
  const root = mkdtempSync(join(tmpdir(), "orch-spawn-"));
  mkdirSync(join(root, ".git"), { recursive: true });
  const db = connectPath(join(root, ".pipeline", "pipeline.db"));
  try {
    projectAdd(db, { name: "test-project", rootPath: root });
    rowAdd(db, "test-project", {
      feature: "dev-test-feature",
      planFile: "test.md",
      stage: "dev",
    });
    const row = db.prepare("SELECT * FROM pipeline_rows WHERE feature = ?").get("dev-test-feature");
    strictEqual(row.stage, "dev");
    ok(row.stage, "stage is defined");
  } finally {
    close(db);
    rmSync(root, { recursive: true });
  }
});

test("orchestrator stage-driven spawn: review stage row", () => {
  const root = mkdtempSync(join(tmpdir(), "orch-spawn-"));
  mkdirSync(join(root, ".git"), { recursive: true });
  const db = connectPath(join(root, ".pipeline", "pipeline.db"));
  try {
    projectAdd(db, { name: "test-project", rootPath: root });
    rowAdd(db, "test-project", {
      feature: "review-test-feature",
      planFile: "test.md",
      stage: "review",
    });
    const row = db.prepare("SELECT * FROM pipeline_rows WHERE feature = ?").get("review-test-feature");
    strictEqual(row.stage, "review");
  } finally {
    close(db);
    rmSync(root, { recursive: true });
  }
});

test("orchestrator stage-driven spawn: test stage row", () => {
  const root = mkdtempSync(join(tmpdir(), "orch-spawn-"));
  mkdirSync(join(root, ".git"), { recursive: true });
  const db = connectPath(join(root, ".pipeline", "pipeline.db"));
  try {
    projectAdd(db, { name: "test-project", rootPath: root });
    rowAdd(db, "test-project", {
      feature: "test-test-feature",
      planFile: "test.md",
      stage: "test",
    });
    const row = db.prepare("SELECT * FROM pipeline_rows WHERE feature = ?").get("test-test-feature");
    strictEqual(row.stage, "test");
  } finally {
    close(db);
    rmSync(root, { recursive: true });
  }
});

test("orchestrator stage-driven spawn: research stage row", () => {
  const root = mkdtempSync(join(tmpdir(), "orch-spawn-"));
  mkdirSync(join(root, ".git"), { recursive: true });
  const db = connectPath(join(root, ".pipeline", "pipeline.db"));
  try {
    projectAdd(db, { name: "test-project", rootPath: root });
    rowAdd(db, "test-project", {
      feature: "research-test-feature",
      planFile: "test.md",
      stage: "research",
    });
    const row = db.prepare("SELECT * FROM pipeline_rows WHERE feature = ?").get("research-test-feature");
    strictEqual(row.stage, "research");
  } finally {
    close(db);
    rmSync(root, { recursive: true });
  }
});

test("orchestrator stage-driven spawn: queued row with type=dev in notes", () => {
  const root = mkdtempSync(join(tmpdir(), "orch-spawn-"));
  mkdirSync(join(root, ".git"), { recursive: true });
  const db = connectPath(join(root, ".pipeline", "pipeline.db"));
  try {
    projectAdd(db, { name: "test-project", rootPath: root });
    rowAdd(db, "test-project", {
      feature: "queued-with-type",
      planFile: "test.md",
      stage: "queued",
    });
    rowUpdate(db, "test-project", "queued-with-type", { notes_extra: "type=dev" });
    const row = db.prepare("SELECT * FROM pipeline_rows WHERE feature = ?").get("queued-with-type");
    strictEqual(row.stage, "queued");
    match(row.notes_extra, /type=dev/);
  } finally {
    close(db);
    rmSync(root, { recursive: true });
  }
});

test("orchestrator stage-driven spawn: queued row defaults to dev when no type= hint", () => {
  const root = mkdtempSync(join(tmpdir(), "orch-spawn-"));
  mkdirSync(join(root, ".git"), { recursive: true });
  const db = connectPath(join(root, ".pipeline", "pipeline.db"));
  try {
    projectAdd(db, { name: "test-project", rootPath: root });
    rowAdd(db, "test-project", {
      feature: "queued-no-type",
      planFile: "test.md",
      stage: "queued",
    });
    rowUpdate(db, "test-project", "queued-no-type", { notes_extra: "some audit log" });
    const row = db.prepare("SELECT * FROM pipeline_rows WHERE feature = ?").get("queued-no-type");
    strictEqual(row.stage, "queued");
  } finally {
    close(db);
    rmSync(root, { recursive: true });
  }
});

test("orchestrator stage-driven spawn: manual stage row is skipped", () => {
  const root = mkdtempSync(join(tmpdir(), "orch-spawn-"));
  mkdirSync(join(root, ".git"), { recursive: true });
  const db = connectPath(join(root, ".pipeline", "pipeline.db"));
  try {
    projectAdd(db, { name: "test-project", rootPath: root });
    rowAdd(db, "test-project", {
      feature: "manual-feature",
      planFile: "test.md",
      stage: "manual",
    });
    rowUpdate(db, "test-project", "manual-feature", { notes_extra: "blocked: waiting for operator" });
    const row = db.prepare("SELECT * FROM pipeline_rows WHERE feature = ?").get("manual-feature");
    strictEqual(row.stage, "manual");
  } finally {
    close(db);
    rmSync(root, { recursive: true });
  }
});

test("orchestrator stage-driven spawn: reaper recovery advances row to review stage", () => {
  const root = mkdtempSync(join(tmpdir(), "orch-spawn-"));
  mkdirSync(join(root, ".git"), { recursive: true });
  const db = connectPath(join(root, ".pipeline", "pipeline.db"));
  try {
    projectAdd(db, { name: "test-project", rootPath: root });
    rowAdd(db, "test-project", {
      feature: "dev-recovery-feature",
      planFile: "test.md",
      stage: "dev",
      reviewRetries: 0,
      reviewRetryBudget: 3,
    });

    // Simulate reaper recovery: advance to review stage
    rowUpdate(db, "test-project", "dev-recovery-feature", {
      stage: "review",
      notes_extra: "recovery-path [dev-no-handoff-recovered 2026-06-13T14:30:00Z]",
    });

    const row = db.prepare("SELECT * FROM pipeline_rows WHERE feature = ?").get("dev-recovery-feature");
    strictEqual(row.stage, "review");
    // Should not have type= prefix anymore
    const notes = row.notes_extra || "";
    ok(!notes.includes("type="), `notes should not include type=, got: ${notes}`);
    match(notes, /dev-no-handoff-recovered/);
  } finally {
    close(db);
    rmSync(root, { recursive: true });
  }
});

test("orchestrator stage-driven spawn: review row with exhausted retry budget", () => {
  const root = mkdtempSync(join(tmpdir(), "orch-spawn-"));
  mkdirSync(join(root, ".git"), { recursive: true });
  const db = connectPath(join(root, ".pipeline", "pipeline.db"));
  try {
    projectAdd(db, { name: "test-project", rootPath: root });
    rowAdd(db, "test-project", {
      feature: "exhausted-review-feature",
      planFile: "test.md",
      stage: "review",
      reviewRetries: 3,
      reviewRetryBudget: 3,
    });

    const row = db.prepare("SELECT * FROM pipeline_rows WHERE feature = ?").get("exhausted-review-feature");
    strictEqual(row.stage, "review");
    strictEqual(row.review_retries, 3);
    strictEqual(row.review_retry_budget, 3);
    ok(row.review_retries >= row.review_retry_budget, "should be skipped by orchestrator");
  } finally {
    close(db);
    rmSync(root, { recursive: true });
  }
});

test("orchestrator stage-driven spawn: review row with available retries", () => {
  const root = mkdtempSync(join(tmpdir(), "orch-spawn-"));
  mkdirSync(join(root, ".git"), { recursive: true });
  const db = connectPath(join(root, ".pipeline", "pipeline.db"));
  try {
    projectAdd(db, { name: "test-project", rootPath: root });
    rowAdd(db, "test-project", {
      feature: "available-review-feature",
      planFile: "test.md",
      stage: "review",
      reviewRetries: 1,
      reviewRetryBudget: 3,
    });

    const row = db.prepare("SELECT * FROM pipeline_rows WHERE feature = ?").get("available-review-feature");
    strictEqual(row.review_retries, 1);
    ok(row.review_retries < row.review_retry_budget, "should be considered for spawning");
  } finally {
    close(db);
    rmSync(root, { recursive: true });
  }
});

test("orchestrator stage-driven spawn: old dev-stage row with type=dev in notes still works", () => {
  const root = mkdtempSync(join(tmpdir(), "orch-spawn-"));
  mkdirSync(join(root, ".git"), { recursive: true });
  const db = connectPath(join(root, ".pipeline", "pipeline.db"));
  try {
    projectAdd(db, { name: "test-project", rootPath: root });
    rowAdd(db, "test-project", {
      feature: "legacy-dev-feature",
      planFile: "test.md",
      stage: "dev",
    });
    rowUpdate(db, "test-project", "legacy-dev-feature", { notes_extra: "type=dev some audit log" });

    const row = db.prepare("SELECT * FROM pipeline_rows WHERE feature = ?").get("legacy-dev-feature");
    strictEqual(row.stage, "dev");
    match(row.notes_extra, /type=dev/);
  } finally {
    close(db);
    rmSync(root, { recursive: true });
  }
});

test("orchestrator stage-driven spawn: queued row with type=review hint still works", () => {
  const root = mkdtempSync(join(tmpdir(), "orch-spawn-"));
  mkdirSync(join(root, ".git"), { recursive: true });
  const db = connectPath(join(root, ".pipeline", "pipeline.db"));
  try {
    projectAdd(db, { name: "test-project", rootPath: root });
    rowAdd(db, "test-project", {
      feature: "legacy-queued-review",
      planFile: "test.md",
      stage: "queued",
    });
    rowUpdate(db, "test-project", "legacy-queued-review", { notes_extra: "type=review custom session path" });

    const row = db.prepare("SELECT * FROM pipeline_rows WHERE feature = ?").get("legacy-queued-review");
    strictEqual(row.stage, "queued");
  } finally {
    close(db);
    rmSync(root, { recursive: true });
  }
});
