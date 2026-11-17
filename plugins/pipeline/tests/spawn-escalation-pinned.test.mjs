import "./helpers/isolate-home.mjs";
import { test } from "node:test";
import { ok, equal } from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { rowAdd, rowGet } from "../src/db/index.mjs";
import { spawnSession, nextEscalationStepPinned, proxyEnvFor } from "../src/orchestrator/spawn.mjs";
import { PIPELINE_DEFAULTS } from "../src/config-defaults.mjs";
import { PROJECT, noopNotify, createMockLog, setup, teardown } from "./helpers/spawn-harness.mjs";

// ── Pinned (non-Anthropic, proxy-routed) escalation ─────────────────────────

const opusLevels = ["low", "medium", "high", "xhigh", "max"];

test("nextEscalationStepPinned: low → high (effort+2 within opus ladder)", () => {
  const step = nextEscalationStepPinned("low", opusLevels);
  equal(step.effort, "high");
  equal(step.action, "effort+2");
});

test("nextEscalationStepPinned: high → max (effort+2 to ceiling in opus ladder)", () => {
  // Opus ladder has 5 rungs: [low, medium, high, xhigh, max]. From high (idx=2)
  // +2 lands on max (idx=4) — effort+2, not clamp. Same +2 rule as nextEscalationStep.
  const step = nextEscalationStepPinned("high", opusLevels);
  equal(step.effort, "max");
  equal(step.action, "effort+2");
});

test("nextEscalationStepPinned: max → max (stay at ceiling)", () => {
  const step = nextEscalationStepPinned("max", opusLevels);
  equal(step.effort, "max");
  equal(step.action, "stay");
});

test("nextEscalationStepPinned: medium → xhigh (effort+2 within opus ladder)", () => {
  // Opus ladder: low(0), medium(1), high(2), xhigh(3), max(4). From medium (idx=1)
  // +2 = idx 3 → xhigh. Matches nextEscalationStep's "Opus medium → xhigh" mapping.
  const step = nextEscalationStepPinned("medium", opusLevels);
  equal(step.effort, "xhigh");
  equal(step.action, "effort+2");
});

test("nextEscalationStepPinned: xhigh → max (effort-clamp)", () => {
  const step = nextEscalationStepPinned("xhigh", opusLevels);
  equal(step.effort, "max");
  equal(step.action, "effort-clamp");
});

test("nextEscalationStepPinned: unknown effort → stay", () => {
  const step = nextEscalationStepPinned("off-the-charts", opusLevels);
  equal(step.effort, "off-the-charts");
  equal(step.action, "stay");
});

test("proxyEnvFor: returns env block for non-Anthropic model", () => {
  const env = proxyEnvFor("minimax-m3:cloud", { proxy: { url: "http://localhost:18081", auth_token: "dummy" } });
  equal(env.ANTHROPIC_MODEL, "minimax-m3:cloud");
  equal(env.ANTHROPIC_BASE_URL, "http://localhost:18081");
});

test("proxyEnvFor: returns empty env for Anthropic model", () => {
  const env = proxyEnvFor("claude-sonnet-4-6", { proxy: { url: "http://localhost:18081", auth_token: "dummy" } });
  equal(Object.keys(env).length, 0);
});

test("escalation: pinned — non-Anthropic medium row escalates up the opus ladder and leaves d_model unchanged", () => {
  const { tmp, db, projectRoot } = setup();
  try {
    const feature = "test-feat-pinned-minimax";
    const planFile = join(projectRoot, "plan.md");
    const sessionFile = join(projectRoot, "session.md");
    writeFileSync(planFile, "# Plan\n", "utf8");
    writeFileSync(sessionFile, "# Session\n", "utf8");

    rowAdd(db, PROJECT, {
      feature,
      planFile,
      stage: "queued",
      reviewRetries: 1,
      dEffort: "medium",
    });

    const row = rowGet(db, PROJECT, feature);
    row.notes_extra = "type=dev model=minimax-m3:cloud";

    const logFn = createMockLog();
    spawnSession(PROJECT, row, sessionFile, projectRoot, { db, dryRun: true, logFn, _publishNotification: noopNotify });

    // Opus ladder: [low(0), medium(1), high(2), xhigh(3), max(4)]. medium +2 = xhigh.
    ok(logFn.hasMessage("pinned/medium→pinned/xhigh"), "Should show pinned medium→xhigh transition");
    ok(logFn.hasMessage("effort+2"), "Should report effort+2 action");
    const updated = rowGet(db, PROJECT, feature);
    equal(updated.d_effort, "xhigh", "d_effort walks +2 in opus ladder (medium → xhigh)");
    equal(updated.d_model, null, "d_model must NOT be touched by pinned escalation — model name is carried via proxyEnvFor at spawn time, not the row column");
  } finally { teardown(tmp, db); }
});

test("escalation: pinned — non-Anthropic row at ceiling (max) does NOT escalate", () => {
  const { tmp, db, projectRoot } = setup();
  try {
    const feature = "test-feat-pinned-max";
    const planFile = join(projectRoot, "plan.md");
    const sessionFile = join(projectRoot, "session.md");
    writeFileSync(planFile, "# Plan\n", "utf8");
    writeFileSync(sessionFile, "# Session\n", "utf8");

    rowAdd(db, PROJECT, {
      feature,
      planFile,
      stage: "queued",
      reviewRetries: 1,
      dEffort: "max",
    });

    const row = rowGet(db, PROJECT, feature);
    row.notes_extra = "type=dev model=minimax-m3:cloud";

    const logFn = createMockLog();
    spawnSession(PROJECT, row, sessionFile, projectRoot, { db, dryRun: true, logFn, _publishNotification: noopNotify });

    ok(!logFn.hasMessage("escalating"), "Should not escalate pinned at ceiling");
    const updated = rowGet(db, PROJECT, feature);
    equal(updated.d_effort, "max", "d_effort stays at max");
    equal(updated.d_model, null, "d_model unchanged (null) — pinned escalation never touches the column");
  } finally { teardown(tmp, db); }
});

test("escalation: pinned — non-Anthropic row at high escalates to max (effort+2)", () => {
  const { tmp, db, projectRoot } = setup();
  try {
    const feature = "test-feat-pinned-high";
    const planFile = join(projectRoot, "plan.md");
    const sessionFile = join(projectRoot, "session.md");
    writeFileSync(planFile, "# Plan\n", "utf8");
    writeFileSync(sessionFile, "# Session\n", "utf8");

    rowAdd(db, PROJECT, {
      feature,
      planFile,
      stage: "queued",
      reviewRetries: 1,
      dEffort: "high",
    });

    const row = rowGet(db, PROJECT, feature);
    row.notes_extra = "type=dev model=qwen2.5-coder:32b";

    const logFn = createMockLog();
    spawnSession(PROJECT, row, sessionFile, projectRoot, { db, dryRun: true, logFn, _publishNotification: noopNotify });

    ok(logFn.hasMessage("pinned/high→pinned/max"), "Should show pinned high→max transition");
    ok(logFn.hasMessage("effort+2"), "Should report effort+2 action (opus ladder: high idx=2 +2 = max idx=4)");
    const updated = rowGet(db, PROJECT, feature);
    equal(updated.d_effort, "max");
    equal(updated.d_model, null, "d_model unchanged — pinned escalation never touches the column");
  } finally { teardown(tmp, db); }
});

test("escalation: pinned — non-Anthropic row at xhigh clamps to max (effort-clamp)", () => {
  const { tmp, db, projectRoot } = setup();
  try {
    const feature = "test-feat-pinned-xhigh";
    const planFile = join(projectRoot, "plan.md");
    const sessionFile = join(projectRoot, "session.md");
    writeFileSync(planFile, "# Plan\n", "utf8");
    writeFileSync(sessionFile, "# Session\n", "utf8");

    rowAdd(db, PROJECT, {
      feature,
      planFile,
      stage: "queued",
      reviewRetries: 1,
      dEffort: "xhigh",
    });

    const row = rowGet(db, PROJECT, feature);
    row.notes_extra = "type=dev model=minimax-m3:cloud";

    const logFn = createMockLog();
    spawnSession(PROJECT, row, sessionFile, projectRoot, { db, dryRun: true, logFn, _publishNotification: noopNotify });

    ok(logFn.hasMessage("pinned/xhigh→pinned/max"), "Should show pinned xhigh→max transition");
    ok(logFn.hasMessage("effort-clamp"), "Should report effort-clamp action (xhigh idx=3 +2 overflows)");
    const updated = rowGet(db, PROJECT, feature);
    equal(updated.d_effort, "max");
    equal(updated.d_model, null, "d_model unchanged — pinned escalation never touches the column");
  } finally { teardown(tmp, db); }
});

test("escalation: pinned — does NOT escalate when review_retries = 0", () => {
  const { tmp, db, projectRoot } = setup();
  try {
    const feature = "test-feat-pinned-no-retries";
    const planFile = join(projectRoot, "plan.md");
    const sessionFile = join(projectRoot, "session.md");
    writeFileSync(planFile, "# Plan\n", "utf8");
    writeFileSync(sessionFile, "# Session\n", "utf8");

    rowAdd(db, PROJECT, {
      feature,
      planFile,
      stage: "queued",
      reviewRetries: 0,
      dEffort: "medium",
    });

    const row = rowGet(db, PROJECT, feature);
    row.notes_extra = "type=dev model=minimax-m3:cloud";

    const logFn = createMockLog();
    spawnSession(PROJECT, row, sessionFile, projectRoot, { db, dryRun: true, logFn, _publishNotification: noopNotify });

    ok(!logFn.hasMessage("escalating"), "Pinned model should not escalate at review_retries = 0");
  } finally { teardown(tmp, db); }
});

test("escalation: injected _cfg tier_efforts ladder wins over the on-disk config (guard)", () => {
  const { tmp, db, projectRoot } = setup();
  try {
    const feature = "test-feat-cfg-ladder";
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
    row.notes_extra = "type=dev model=minimax-m3:cloud";
    row.d_effort = "medium";

    // Non-default opus ladder: medium +2 lands on max. The shipped ladder lands
    // on xhigh, so a re-read of the on-disk config changes the answer.
    const cfg = {
      ...PIPELINE_DEFAULTS,
      tier_efforts: { ...PIPELINE_DEFAULTS.tier_efforts, opus: ["low", "medium", "high", "max"] },
    };

    const logFn = createMockLog();
    spawnSession(PROJECT, row, sessionFile, projectRoot, {
      db, dryRun: true, logFn, _publishNotification: noopNotify, _cfg: cfg,
    });

    ok(logFn.hasMessage("pinned/medium→pinned/max"), "custom ladder medium+2 = max");
    ok(logFn.hasMessage("effort+2"), "Should report effort+2 action");
    const updated = rowGet(db, PROJECT, feature);
    equal(updated.d_effort, "max", "d_effort follows the injected ladder (the shipped ladder gives xhigh)");
  } finally { teardown(tmp, db); }
});
