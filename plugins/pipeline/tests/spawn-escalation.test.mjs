import { test } from "node:test";
import { ok, equal } from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { connectPath, close, projectAdd, rowAdd, rowGet } from "../scripts/pipeline-db/index.mjs";
import { tierFromModel, nextEscalationStep, spawnSession } from "../scripts/orchestrator/spawn.mjs";
import { PIPELINE_DEFAULTS } from "../src/config-defaults.mjs";

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

// ── Unit tests for tierFromModel ──────────────────────────────────────────

test("tierFromModel: classifies Haiku variants correctly", () => {
  equal(tierFromModel("claude-haiku-4-5"), "haiku", "Base Haiku model");
  equal(tierFromModel("claude-haiku-4-5-20251001"), "haiku", "Haiku with dated suffix");
  equal(tierFromModel("CLAUDE-HAIKU-4-5"), "haiku", "Case-insensitive");
});

test("tierFromModel: classifies Sonnet variants correctly", () => {
  equal(tierFromModel("claude-sonnet-4-6"), "sonnet", "Base Sonnet model");
  equal(tierFromModel("claude-sonnet-4-6-20260101"), "sonnet", "Sonnet with dated suffix");
});

test("tierFromModel: classifies Opus variants correctly", () => {
  equal(tierFromModel("claude-opus-4-8"), "opus", "Base Opus model");
  equal(tierFromModel("claude-opus-4-7-20260518"), "opus", "Opus with dated suffix");
});

test("tierFromModel: classifies Fable and Mythos correctly", () => {
  equal(tierFromModel("claude-fable-5"), "fable", "Fable model");
  equal(tierFromModel("claude-mythos"), "fable", "Mythos aliases to fable");
});

test("tierFromModel: returns null for unknown models", () => {
  equal(tierFromModel("unknown-model"), null, "Unknown model");
  equal(tierFromModel(""), null, "Empty string");
});

// ── Unit tests for nextEscalationStep ────────────────────────────────────

test("nextEscalationStep: effort +2 within tier (Opus medium → xhigh)", () => {
  const step = nextEscalationStep("opus", "medium", PIPELINE_DEFAULTS.tier_efforts);
  equal(step.tier, "opus", "Tier unchanged");
  equal(step.effort, "xhigh", "Effort +2");
  equal(step.action, "effort+2", "Action is effort+2");
});

test("nextEscalationStep: effort +2 skip-rung (Sonnet medium → max)", () => {
  const step = nextEscalationStep("sonnet", "medium", PIPELINE_DEFAULTS.tier_efforts);
  equal(step.tier, "sonnet", "Tier unchanged");
  equal(step.effort, "max", "Sonnet medium+2 skips xhigh, lands on max");
  equal(step.action, "effort+2", "Action is effort+2");
});

test("nextEscalationStep: effort clamp on overflow (Sonnet high → max)", () => {
  const step = nextEscalationStep("sonnet", "high", PIPELINE_DEFAULTS.tier_efforts);
  equal(step.tier, "sonnet", "Tier unchanged");
  equal(step.effort, "max", "High+2 overflows, clamped to max");
  equal(step.action, "effort-clamp", "Action is effort-clamp");
});

test("nextEscalationStep: tier-jump from Haiku ceiling (high → Sonnet medium)", () => {
  const step = nextEscalationStep("haiku", "high", PIPELINE_DEFAULTS.tier_efforts);
  equal(step.tier, "sonnet", "Tier jumped to Sonnet");
  equal(step.effort, "medium", "Effort reset to medium");
  equal(step.action, "tier-jump", "Action is tier-jump");
});

test("nextEscalationStep: tier-jump from Sonnet ceiling (max → Opus medium)", () => {
  const step = nextEscalationStep("sonnet", "max", PIPELINE_DEFAULTS.tier_efforts);
  equal(step.tier, "opus", "Tier jumped to Opus");
  equal(step.effort, "medium", "Effort reset to medium");
  equal(step.action, "tier-jump", "Action is tier-jump");
});

test("nextEscalationStep: top-tier stay (Opus max → Opus max)", () => {
  const step = nextEscalationStep("opus", "max", PIPELINE_DEFAULTS.tier_efforts);
  equal(step.tier, "opus", "Tier unchanged");
  equal(step.effort, "max", "Effort unchanged");
  equal(step.action, "stay", "Action is stay");
});

test("nextEscalationStep: illegal pin handling (Haiku/max → Sonnet/medium)", () => {
  // Haiku doesn't support max, so treat as above-ceiling
  const step = nextEscalationStep("haiku", "max", PIPELINE_DEFAULTS.tier_efforts);
  equal(step.tier, "sonnet", "Tier jumped to Sonnet");
  equal(step.effort, "medium", "Effort reset to medium");
  equal(step.action, "tier-jump", "Action is tier-jump");
});

// ── Integration tests for spawnSession escalation ────────────────────────

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
    });

    const row = rowGet(db, PROJECT, feature);
    row.notes_extra = "type=dev model=claude-haiku-4-5 effort=medium";

    const logFn = createMockLog();
    spawnSession(PROJECT, row, sessionFile, projectRoot, { db, dryRun: true, logFn });

    ok(!logFn.hasMessage("escalating"), "Should not escalate when review_retries = 0");
  } finally { teardown(tmp, db); }
});

test("escalation: ESCALATES when review_retries >= 1 on Haiku/low (effort+2)", () => {
  const { tmp, db, projectRoot } = setup();
  try {
    const feature = "test-feat-escalate";
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
    row.notes_extra = "type=dev model=claude-haiku-4-5 effort=low";

    const logFn = createMockLog();
    spawnSession(PROJECT, row, sessionFile, projectRoot, { db, dryRun: true, logFn });

    ok(logFn.hasMessage("escalating"), "Should escalate at review_retries >= 1");
    ok(logFn.hasMessage("haiku/low→haiku/high"), "Should step Haiku low → high (+2)");
    ok(logFn.hasMessage("effort+2"), "Should log action as effort+2");
  } finally { teardown(tmp, db); }
});

test("escalation: effort clamp on Haiku/medium → high", () => {
  const { tmp, db, projectRoot } = setup();
  try {
    const feature = "test-feat-clamp";
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
    row.notes_extra = "type=dev model=claude-haiku-4-5 effort=medium";

    const logFn = createMockLog();
    spawnSession(PROJECT, row, sessionFile, projectRoot, { db, dryRun: true, logFn });

    ok(logFn.hasMessage("escalating"), "Should escalate at review_retries >= 1");
    ok(logFn.hasMessage("haiku/medium→haiku/high"), "Should clamp Haiku medium+2 to high");
    ok(logFn.hasMessage("effort-clamp"), "Should log action as effort-clamp");
  } finally { teardown(tmp, db); }
});

test("escalation: tier-jump from Haiku ceiling to Sonnet on second retry", () => {
  const { tmp, db, projectRoot } = setup();
  try {
    const feature = "test-feat-jump";
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
    // Start at Haiku/high (at ceiling)
    row.notes_extra = "type=dev model=claude-haiku-4-5 effort=high";

    const logFn = createMockLog();
    spawnSession(PROJECT, row, sessionFile, projectRoot, { db, dryRun: true, logFn });

    ok(logFn.hasMessage("haiku/high→sonnet/medium"), "Should tier-jump from Haiku high to Sonnet medium");
    ok(logFn.hasMessage("tier-jump"), "Should log action as tier-jump");
  } finally { teardown(tmp, db); }
});

test("escalation: persists d_model on tier-jump", () => {
  const { tmp, db, projectRoot } = setup();
  try {
    const feature = "test-feat-model-persist";
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
    row.notes_extra = "type=dev model=claude-haiku-4-5 effort=high";

    const logFn = createMockLog();
    spawnSession(PROJECT, row, sessionFile, projectRoot, { db, dryRun: true, logFn });

    const updated = rowGet(db, PROJECT, feature);
    equal(updated.d_model, "claude-sonnet-4-6", "d_model should be updated to Sonnet");
  } finally { teardown(tmp, db); }
});

test("escalation: persists d_effort on effort-only step", () => {
  const { tmp, db, projectRoot } = setup();
  try {
    const feature = "test-feat-effort-persist";
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
    row.notes_extra = "type=dev model=claude-haiku-4-5 effort=medium";

    const logFn = createMockLog();
    spawnSession(PROJECT, row, sessionFile, projectRoot, { db, dryRun: true, logFn });

    const updated = rowGet(db, PROJECT, feature);
    equal(updated.d_effort, "high", "d_effort should be updated to high");
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
    row.notes_extra = "type=review model=claude-haiku-4-5 effort=medium";

    const logFn = createMockLog();
    spawnSession(PROJECT, row, sessionFile, projectRoot, { db, dryRun: true, logFn });

    ok(!logFn.hasMessage("escalating"), "Should not escalate for review stype");
  } finally { teardown(tmp, db); }
});

test("escalation: Opus max stays put", () => {
  const { tmp, db, projectRoot } = setup();
  try {
    const feature = "test-feat-opus-stay";
    const planFile = join(projectRoot, "plan.md");
    const sessionFile = join(projectRoot, "session.md");
    writeFileSync(planFile, "# Plan\n", "utf8");
    writeFileSync(sessionFile, "# Session\n", "utf8");

    rowAdd(db, PROJECT, {
      feature,
      planFile,
      stage: "queued",
      reviewRetries: 5,
    });

    const row = rowGet(db, PROJECT, feature);
    row.notes_extra = "type=dev model=claude-opus-4-8 effort=max";

    const logFn = createMockLog();
    spawnSession(PROJECT, row, sessionFile, projectRoot, { db, dryRun: true, logFn });

    ok(!logFn.hasMessage("escalating"), "Opus max should not escalate");
  } finally { teardown(tmp, db); }
});
