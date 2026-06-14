import { test } from "node:test";
import { ok, equal } from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { connectPath, close, projectAdd, rowAdd, rowGet } from "../scripts/pipeline-db/index.mjs";
import { spawnSession, tierFromModel, nextEscalationStep } from "../scripts/orchestrator/spawn.mjs";

const PROJECT = "testproject";

function createMockLog() {
  const logs = [];
  const fn = (msg, level = "INFO") => { logs.push({ msg, level }); };
  fn.getLogs = () => logs;
  fn.hasMessage = (substr) => logs.some(l => l.msg.includes(substr));
  return fn;
}

function setup() {
  const tmp = mkdtempSync(join(tmpdir(), "spawn-escalation-"));
  const dbPath = join(tmp, "pipeline.db");
  const projectRoot = join(tmp, "project");
  mkdirSync(join(projectRoot, ".git"), { recursive: true });
  const db = connectPath(dbPath);
  projectAdd(db, { name: PROJECT, rootPath: projectRoot });
  return { tmp, db, projectRoot };
}

function teardown(tmp, db) {
  try { close(db); } catch {}
  rmSync(tmp, { recursive: true, force: true });
}

// Unit tests for tierFromModel
test("tierFromModel: classify Haiku", () => {
  equal(tierFromModel("claude-haiku-4-5"), "haiku");
  equal(tierFromModel("claude-haiku-4-5-20251001"), "haiku");
  equal(tierFromModel("CLAUDE-HAIKU-4-5"), "haiku");
});

test("tierFromModel: classify Sonnet", () => {
  equal(tierFromModel("claude-sonnet-4-6"), "sonnet");
  equal(tierFromModel("claude-sonnet-4-6-20260101"), "sonnet");
});

test("tierFromModel: classify Opus", () => {
  equal(tierFromModel("claude-opus-4-8"), "opus");
  equal(tierFromModel("claude-opus-4-7-20260518"), "opus");
});

test("tierFromModel: classify Fable", () => {
  equal(tierFromModel("claude-fable-5"), "fable");
  equal(tierFromModel("claude-mythos-1-0"), "fable");
});

test("tierFromModel: unknown model returns null", () => {
  equal(tierFromModel("unknown-model"), null);
  equal(tierFromModel("gpt-4"), null);
});

// Unit tests for nextEscalationStep
const tierEfforts = {
  haiku:  ["low", "medium", "high"],
  sonnet: ["low", "medium", "high", "max"],
  opus:   ["low", "medium", "high", "xhigh", "max"],
};

test("escalation: effort+2 within tier (Opus medium → xhigh)", () => {
  const step = nextEscalationStep("opus", "medium", tierEfforts);
  equal(step.tier, "opus");
  equal(step.effort, "xhigh");
  equal(step.action, "effort+2");
});

test("escalation: effort+2 skip-rung within tier (Sonnet medium → max)", () => {
  const step = nextEscalationStep("sonnet", "medium", tierEfforts);
  equal(step.tier, "sonnet");
  equal(step.effort, "max");
  equal(step.action, "effort+2");
});

test("escalation: effort clamp on overflow (Sonnet high → max)", () => {
  const step = nextEscalationStep("sonnet", "high", tierEfforts);
  equal(step.tier, "sonnet");
  equal(step.effort, "max");
  equal(step.action, "effort-clamp");
});

test("escalation: tier-jump from Haiku ceiling (Haiku high → Sonnet medium)", () => {
  const step = nextEscalationStep("haiku", "high", tierEfforts);
  equal(step.tier, "sonnet");
  equal(step.effort, "medium");
  equal(step.action, "tier-jump");
});

test("escalation: tier-jump from Sonnet ceiling (Sonnet max → Opus medium)", () => {
  const step = nextEscalationStep("sonnet", "max", tierEfforts);
  equal(step.tier, "opus");
  equal(step.effort, "medium");
  equal(step.action, "tier-jump");
});

test("escalation: top-tier stay (Opus max → Opus max)", () => {
  const step = nextEscalationStep("opus", "max", tierEfforts);
  equal(step.tier, "opus");
  equal(step.effort, "max");
  equal(step.action, "stay");
});

test("escalation: illegal pin handling (Haiku/max → tier-jump)", () => {
  const step = nextEscalationStep("haiku", "max", tierEfforts);
  equal(step.tier, "sonnet");
  equal(step.effort, "medium");
  equal(step.action, "tier-jump");
});

test("escalation: unknown tier returns null", () => {
  const step = nextEscalationStep("unknown", "medium", tierEfforts);
  equal(step, null);
});

// Integration tests with spawnSession
test("escalation: does NOT escalate when review_retries = 0", () => {
  const { tmp, db, projectRoot } = setup();
  try {
    const feature = "test-feat-0";
    const planFile = join(projectRoot, "plan.md");
    const sessionFile = join(projectRoot, "session.md");
    writeFileSync(planFile, "# Plan\n", "utf8");
    writeFileSync(sessionFile, "# Session\n", "utf8");

    rowAdd(db, PROJECT, {
      feature,
      planFile,
      stage: "queued",
      reviewRetries: 0,
      d_effort: "medium",
    });

    const row = rowGet(db, PROJECT, feature);
    row.notes_extra = "type=dev model=claude-haiku-4-5";

    const logFn = createMockLog();
    spawnSession(PROJECT, row, sessionFile, projectRoot, { db, dryRun: true, logFn });

    ok(!logFn.hasMessage("escalating"), "Should not escalate when review_retries = 0");
  } finally { teardown(tmp, db); }
});

test("escalation: ESCALATES when review_retries >= 1 (Haiku medium → high, effort-clamp)", () => {
  const { tmp, db, projectRoot } = setup();
  try {
    const feature = "test-feat-haiku-medium";
    const planFile = join(projectRoot, "plan.md");
    const sessionFile = join(projectRoot, "session.md");
    writeFileSync(planFile, "# Plan\n", "utf8");
    writeFileSync(sessionFile, "# Session\n", "utf8");

    rowAdd(db, PROJECT, {
      feature,
      planFile,
      stage: "queued",
      reviewRetries: 1,
      d_effort: "medium",
    });

    const row = rowGet(db, PROJECT, feature);
    row.notes_extra = "type=dev model=claude-haiku-4-5";

    const logFn = createMockLog();
    spawnSession(PROJECT, row, sessionFile, projectRoot, { db, dryRun: true, logFn });

    ok(logFn.hasMessage("escalating"), "Should escalate at review_retries >= 1");
    ok(logFn.hasMessage("effort-clamp"), "Should show effort-clamp action (Haiku has only 3 rungs)");
    ok(logFn.hasMessage("haiku/medium→haiku/high"), "Should show correct transition");
  } finally { teardown(tmp, db); }
});

test("escalation: Haiku high → Sonnet medium (tier-jump)", () => {
  const { tmp, db, projectRoot } = setup();
  try {
    const feature = "test-feat-haiku-high";
    const planFile = join(projectRoot, "plan.md");
    const sessionFile = join(projectRoot, "session.md");
    writeFileSync(planFile, "# Plan\n", "utf8");
    writeFileSync(sessionFile, "# Session\n", "utf8");

    rowAdd(db, PROJECT, {
      feature,
      planFile,
      stage: "queued",
      reviewRetries: 1,
    });

    const row = rowGet(db, PROJECT, feature);
    row.notes_extra = "type=dev model=claude-haiku-4-5";
    row.d_effort = "high";

    const logFn = createMockLog();
    spawnSession(PROJECT, row, sessionFile, projectRoot, { db, dryRun: true, logFn });

    ok(logFn.hasMessage("escalating"), "Should escalate");
    ok(logFn.hasMessage("tier-jump"), "Should show tier-jump action");
    ok(logFn.hasMessage("haiku/high→sonnet/medium"), "Should show tier-jump transition");
  } finally { teardown(tmp, db); }
});

test("escalation: Sonnet medium → max (effort+2, skip-rung)", () => {
  const { tmp, db, projectRoot } = setup();
  try {
    const feature = "test-feat-sonnet-medium";
    const planFile = join(projectRoot, "plan.md");
    const sessionFile = join(projectRoot, "session.md");
    writeFileSync(planFile, "# Plan\n", "utf8");
    writeFileSync(sessionFile, "# Session\n", "utf8");

    rowAdd(db, PROJECT, {
      feature,
      planFile,
      stage: "queued",
      reviewRetries: 1,
    });

    const row = rowGet(db, PROJECT, feature);
    row.notes_extra = "type=dev model=claude-sonnet-4-6";
    row.d_effort = "medium";

    const logFn = createMockLog();
    spawnSession(PROJECT, row, sessionFile, projectRoot, { db, dryRun: true, logFn });

    ok(logFn.hasMessage("escalating"), "Should escalate");
    ok(logFn.hasMessage("effort+2"), "Should show effort+2 action");
    ok(logFn.hasMessage("sonnet/medium→sonnet/max"), "Should show correct transition");
  } finally { teardown(tmp, db); }
});

test("escalation: Sonnet high → max (effort-clamp)", () => {
  const { tmp, db, projectRoot } = setup();
  try {
    const feature = "test-feat-sonnet-high";
    const planFile = join(projectRoot, "plan.md");
    const sessionFile = join(projectRoot, "session.md");
    writeFileSync(planFile, "# Plan\n", "utf8");
    writeFileSync(sessionFile, "# Session\n", "utf8");

    rowAdd(db, PROJECT, {
      feature,
      planFile,
      stage: "queued",
      reviewRetries: 1,
    });

    const row = rowGet(db, PROJECT, feature);
    row.notes_extra = "type=dev model=claude-sonnet-4-6";
    row.d_effort = "high";

    const logFn = createMockLog();
    spawnSession(PROJECT, row, sessionFile, projectRoot, { db, dryRun: true, logFn });

    ok(logFn.hasMessage("escalating"), "Should escalate");
    ok(logFn.hasMessage("effort-clamp"), "Should show effort-clamp action");
    ok(logFn.hasMessage("sonnet/high→sonnet/max"), "Should show correct transition");
  } finally { teardown(tmp, db); }
});

test("escalation: Sonnet max → Opus medium (tier-jump)", () => {
  const { tmp, db, projectRoot } = setup();
  try {
    const feature = "test-feat-sonnet-max";
    const planFile = join(projectRoot, "plan.md");
    const sessionFile = join(projectRoot, "session.md");
    writeFileSync(planFile, "# Plan\n", "utf8");
    writeFileSync(sessionFile, "# Session\n", "utf8");

    rowAdd(db, PROJECT, {
      feature,
      planFile,
      stage: "queued",
      reviewRetries: 1,
    });

    const row = rowGet(db, PROJECT, feature);
    row.notes_extra = "type=dev model=claude-sonnet-4-6";
    row.d_effort = "max";

    const logFn = createMockLog();
    spawnSession(PROJECT, row, sessionFile, projectRoot, { db, dryRun: true, logFn });

    ok(logFn.hasMessage("escalating"), "Should escalate");
    ok(logFn.hasMessage("tier-jump"), "Should show tier-jump action");
    ok(logFn.hasMessage("sonnet/max→opus/medium"), "Should show tier-jump transition");
  } finally { teardown(tmp, db); }
});

test("escalation: Opus max → Opus max (stay, no escalation)", () => {
  const { tmp, db, projectRoot } = setup();
  try {
    const feature = "test-feat-opus-max";
    const planFile = join(projectRoot, "plan.md");
    const sessionFile = join(projectRoot, "session.md");
    writeFileSync(planFile, "# Plan\n", "utf8");
    writeFileSync(sessionFile, "# Session\n", "utf8");

    rowAdd(db, PROJECT, {
      feature,
      planFile,
      stage: "queued",
      reviewRetries: 1,
    });

    const row = rowGet(db, PROJECT, feature);
    row.notes_extra = "type=dev model=claude-opus-4-8";
    row.d_effort = "max";

    const logFn = createMockLog();
    spawnSession(PROJECT, row, sessionFile, projectRoot, { db, dryRun: true, logFn });

    ok(!logFn.hasMessage("escalating"), "Should not escalate at top tier ceiling");
  } finally { teardown(tmp, db); }
});

test("escalation: illegal pin (Haiku/max) → tier-jump to Sonnet/medium", () => {
  const { tmp, db, projectRoot } = setup();
  try {
    const feature = "test-feat-illegal-pin";
    const planFile = join(projectRoot, "plan.md");
    const sessionFile = join(projectRoot, "session.md");
    writeFileSync(planFile, "# Plan\n", "utf8");
    writeFileSync(sessionFile, "# Session\n", "utf8");

    rowAdd(db, PROJECT, {
      feature,
      planFile,
      stage: "queued",
      reviewRetries: 1,
    });

    const row = rowGet(db, PROJECT, feature);
    row.notes_extra = "type=dev model=claude-haiku-4-5";
    row.d_effort = "max";

    const logFn = createMockLog();
    spawnSession(PROJECT, row, sessionFile, projectRoot, { db, dryRun: true, logFn });

    ok(logFn.hasMessage("escalating"), "Should escalate from illegal pin");
    ok(logFn.hasMessage("tier-jump"), "Should perform tier-jump");
    ok(logFn.hasMessage("haiku/max→sonnet/medium"), "Should show correct transition");
  } finally { teardown(tmp, db); }
});

test("escalation: does NOT escalate for review stype", () => {
  const { tmp, db, projectRoot } = setup();
  try {
    const feature = "test-feat-review";
    const planFile = join(projectRoot, "plan.md");
    const sessionFile = join(projectRoot, "session.md");
    writeFileSync(planFile, "# Plan\n", "utf8");
    writeFileSync(sessionFile, "# Session\n", "utf8");

    rowAdd(db, PROJECT, {
      feature,
      planFile,
      stage: "queued",
      reviewRetries: 1,
    });

    const row = rowGet(db, PROJECT, feature);
    row.notes_extra = "type=review model=claude-haiku-4-5";
    row.rvw_effort = "medium";

    const logFn = createMockLog();
    spawnSession(PROJECT, row, sessionFile, projectRoot, { db, dryRun: true, logFn });

    ok(!logFn.hasMessage("escalating"), "Should not escalate for review stype");
  } finally { teardown(tmp, db); }
});

test("escalation: dated suffix classified correctly", () => {
  const { tmp, db, projectRoot } = setup();
  try {
    const feature = "test-feat-dated";
    const planFile = join(projectRoot, "plan.md");
    const sessionFile = join(projectRoot, "session.md");
    writeFileSync(planFile, "# Plan\n", "utf8");
    writeFileSync(sessionFile, "# Session\n", "utf8");

    rowAdd(db, PROJECT, {
      feature,
      planFile,
      stage: "queued",
      reviewRetries: 1,
    });

    const row = rowGet(db, PROJECT, feature);
    row.notes_extra = "type=dev model=claude-haiku-4-5-20251001";
    row.d_effort = "medium";

    const logFn = createMockLog();
    spawnSession(PROJECT, row, sessionFile, projectRoot, { db, dryRun: true, logFn });

    ok(logFn.hasMessage("escalating"), "Should escalate dated model");
    ok(logFn.hasMessage("haiku/medium→haiku/high"), "Should show correct transition");
  } finally { teardown(tmp, db); }
});

test("escalation: persists both d_model and d_effort to DB (tier-jump)", () => {
  const { tmp, db, projectRoot } = setup();
  try {
    const feature = "test-feat-persist";
    const planFile = join(projectRoot, "plan.md");
    const sessionFile = join(projectRoot, "session.md");
    writeFileSync(planFile, "# Plan\n", "utf8");
    writeFileSync(sessionFile, "# Session\n", "utf8");

    rowAdd(db, PROJECT, {
      feature,
      planFile,
      stage: "queued",
      reviewRetries: 1,
    });

    const row = rowGet(db, PROJECT, feature);
    row.notes_extra = "type=dev model=claude-haiku-4-5";
    row.d_effort = "high";

    const logFn = createMockLog();
    spawnSession(PROJECT, row, sessionFile, projectRoot, { db, dryRun: true, logFn });

    const updated = rowGet(db, PROJECT, feature);
    equal(updated.d_model, "claude-sonnet-4-6", "d_model should be updated to sonnet");
    equal(updated.d_effort, "medium", "d_effort should be reset to medium on tier-jump");
  } finally { teardown(tmp, db); }
});

test("escalation: persists d_effort to DB (effort-only escalation, d_model stays unpinned)", () => {
  const { tmp, db, projectRoot } = setup();
  try {
    const feature = "test-feat-persist-effort";
    const planFile = join(projectRoot, "plan.md");
    const sessionFile = join(projectRoot, "session.md");
    writeFileSync(planFile, "# Plan\n", "utf8");
    writeFileSync(sessionFile, "# Session\n", "utf8");

    rowAdd(db, PROJECT, {
      feature,
      planFile,
      stage: "queued",
      reviewRetries: 1,
    });

    const row = rowGet(db, PROJECT, feature);
    // No model= in notes — modelFromNotes resolves from config default, not pinned
    row.notes_extra = "type=dev";
    row.d_effort = "medium";

    const logFn = createMockLog();
    spawnSession(PROJECT, row, sessionFile, projectRoot, { db, dryRun: true, logFn });

    const updated = rowGet(db, PROJECT, feature);
    // Effort-only escalation (Haiku medium → high, no tier change) must NOT write d_model
    equal(updated.d_model, null, "d_model must not be pinned by effort-only escalation");
    equal(updated.d_effort, "high", "d_effort should be updated to high");
  } finally { teardown(tmp, db); }
});

test("escalation: log line carries action label", () => {
  const { tmp, db, projectRoot } = setup();
  try {
    const feature = "test-feat-log";
    const planFile = join(projectRoot, "plan.md");
    const sessionFile = join(projectRoot, "session.md");
    writeFileSync(planFile, "# Plan\n", "utf8");
    writeFileSync(sessionFile, "# Session\n", "utf8");

    rowAdd(db, PROJECT, {
      feature,
      planFile,
      stage: "queued",
      reviewRetries: 1,
    });

    const row = rowGet(db, PROJECT, feature);
    row.notes_extra = "type=dev model=claude-opus-4-8";
    row.d_effort = "medium";

    const logFn = createMockLog();
    spawnSession(PROJECT, row, sessionFile, projectRoot, { db, dryRun: true, logFn });

    const logs = logFn.getLogs();
    const escalateLog = logs.find(l => l.msg.includes("escalating") && l.level === "WARN");
    ok(escalateLog, "Should have WARN log with escalation");
    ok(escalateLog.msg.includes("effort+2"), "Log should contain action label");
  } finally { teardown(tmp, db); }
});
