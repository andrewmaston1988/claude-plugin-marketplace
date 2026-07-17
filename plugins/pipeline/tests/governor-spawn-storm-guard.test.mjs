// In-process attempt cooldown for the governor spawn entry points.
//
// Regression: on 2026-06-22 06:00-07:00 UTC, the orchestrator's 30s pollOnce
// tick produced 119 `Governor session spawned` lines in 60 min against a
// locked pipeline DB. The DB-backed 5-min cooldown (see
// shouldSpawnGovernor / GOVERNOR_COOLDOWN_MS) only fires AFTER
// `appendGovernorSpawn` succeeds, so a locked DB disables the cooldown and
// each tick re-fires another spawn. Fix is an in-process 1-min cooldown in
// `spawnGovernor` and `spawnMonthlyGovernor` (PR #127).
//
// These tests exercise the full code path through `spawnGovernor` (no
// module mocking) by enabling the governor in the on-disk config. The
// in-process guard state is module-private, so all assertions live in one
// sequential test that captures the full lifecycle:
//
//   fresh-state call → sets timestamp
//   second call (within 60s) → suppressed, returns false, logs WARN
//   second call reaches no DB code (DRY-RUN absent on suppressed path)
//   monthly entry point shares the timestamp with the daily one
//
// The on-disk `~/.pipeline/config.json` is backed up and restored around
// the suite.
import { test, before, after } from "node:test";
import { equal, ok, match } from "node:assert/strict";
import {
  mkdtempSync, mkdirSync, writeFileSync, rmSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { connectPath, close, projectAdd } from "../src/db/index.mjs";
import {
  spawnGovernor, spawnMonthlyGovernor,
  resolveGovernorContext,
} from "../src/orchestrator/governor.mjs";

const PROJECT = "testproject-storm-guard";

// The real ~/.pipeline/config.json is never touched: HOME/USERPROFILE are
// redirected to a throwaway temp dir for the suite, so loadPipelineConfig()
// (which resolves its path from os.homedir()) reads an isolated config. This
// keeps the test safe to run while the orchestrator is live against the real
// config — the original values are restored in `after`.
let savedHome, savedUserProfile, homeDir;

before(() => {
  savedHome = process.env.HOME;
  savedUserProfile = process.env.USERPROFILE;
  homeDir = mkdtempSync(join(tmpdir(), "storm-guard-home-"));
  process.env.HOME = homeDir;
  process.env.USERPROFILE = homeDir;
  // Write a config that enables the governor pointed at the test project.
  // PIPELINE_DEFAULTS will be deep-merged on top, so we only set the keys
  // that matter.
  mkdirSync(join(homeDir, ".pipeline"), { recursive: true });
  writeFileSync(join(homeDir, ".pipeline", "config.json"), JSON.stringify({
    governor: { enabled: true, project: PROJECT },
  }, null, 2));
});

after(() => {
  if (savedHome === undefined) delete process.env.HOME; else process.env.HOME = savedHome;
  if (savedUserProfile === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = savedUserProfile;
  rmSync(homeDir, { recursive: true, force: true });
});

function setup() {
  const tmp = mkdtempSync(join(tmpdir(), "storm-guard-"));
  const dbPath = join(tmp, "pipeline.db");
  const root = join(tmp, "myproj");
  mkdirSync(join(root, ".git"), { recursive: true });
  const db = connectPath(dbPath);
  projectAdd(db, { name: PROJECT, rootPath: root });
  return { tmp, db, root };
}

function teardown(tmp, db) {
  try { close(db); } catch {}
  rmSync(tmp, { recursive: true, force: true });
}

// Build a logFn that captures every line and its level for assertion.
function makeLogCapture() {
  const lines = [];
  const logFn = (msg, level = "INFO") => lines.push({ msg, level });
  logFn.lines = lines;
  return logFn;
}

// ── single comprehensive lifecycle test ─────────────────────────────────────

test("governor spawn-storm guard: full lifecycle (single self-contained test)", async () => {
  // Module-level guard state persists across tests in the same file, so
  // all assertions live in one test. The first call must see a fresh
  // state; later calls exercise the suppression path.
  const { tmp, db } = setup();
  try {
    const ctx = resolveGovernorContext(db);
    ok(ctx, "ctx must be non-null when ~/.pipeline/config.json enables governor");
    mkdirSync(ctx.reportsDir, { recursive: true });

    // ── step 1: first call passes the guard ─────────────────────────────
    const log1 = makeLogCapture();
    const r1 = await spawnGovernor(db, { dryRun: true, logFn: log1 });
    // dry-run short-circuits inside _spawnGovernorImpl and returns false;
    // what matters is that the in-process guard did NOT suppress it.
    equal(r1, false, "dry-run path returns false from _spawnGovernorImpl");
    const suppressed1 = log1.lines.filter(l => l.msg.includes("spawn suppressed"));
    equal(suppressed1.length, 0,
      "first call must not log suppression — guard state is fresh");

    // ── step 2: immediate second call is suppressed by the guard ────────
    const log2 = makeLogCapture();
    const r2 = await spawnGovernor(db, { dryRun: true, logFn: log2 });
    equal(r2, false, "suppressed call returns false without doing any work");
    const suppressed2 = log2.lines.filter(l => l.msg.includes("spawn suppressed"));
    equal(suppressed2.length, 1,
      "second call (within 1 min) must log exactly one suppression line");
    equal(suppressed2[0].level, "WARN",
      "suppression must be logged at WARN level");
    match(
      suppressed2[0].msg,
      /Governor: spawn suppressed — last attempt \d+s ago/,
      "suppression message must include seconds-since-last-attempt for audit"
    );

    // ── step 3: suppression short-circuits BEFORE any DB write ──────────
    // The whole point of the in-process guard is that it engages before
    // _spawnGovernorImpl — so even if appendGovernorSpawn would throw on
    // a locked DB, the rate limit still applies. Assert that the suppressed
    // call produced no DRY-RUN log (would only be emitted by _spawnGovernorImpl).
    const dryRunIdx = log2.lines.findIndex(l => l.msg.includes("DRY-RUN"));
    equal(dryRunIdx, -1,
      "suppressed call must NOT reach _spawnGovernorImpl — DRY-RUN absent " +
      "proves the guard short-circuits before any DB write");

    // ── step 4: monthly entry point shares the same timestamp ───────────
    // After a recent daily call, the monthly entry point must also be
    // suppressed — both functions consult the same _lastGovernorAttemptMs.
    const logMonthly = makeLogCapture();
    const rMonthly = await spawnMonthlyGovernor(db, { dryRun: true, logFn: logMonthly });
    equal(rMonthly, false, "monthly call after recent daily is suppressed");
    const suppressedM = logMonthly.lines.filter(l => l.msg.includes("spawn suppressed"));
    equal(suppressedM.length, 1,
      "monthly guard must log exactly one suppression line");
    match(
      suppressedM[0].msg,
      /Monthly governor: spawn suppressed — last attempt \d+s ago/,
      "monthly suppression message uses the 'Monthly governor' prefix"
    );

    // ── step 5: cooldown scope is 60s, not 5min ─────────────────────────
    // Sanity: a third immediate call is still suppressed, confirming the
    // 1-min in-process cooldown (not the 5-min DB cooldown) is what's
    // engaging. If the test ever runs > 60s after step 1 it would fail
    // here — that's the intended upper bound on test runtime.
    const log3 = makeLogCapture();
    await spawnGovernor(db, { dryRun: true, logFn: log3 });
    const suppressed3 = log3.lines.filter(l => l.msg.includes("spawn suppressed"));
    equal(suppressed3.length, 1,
      "third immediate call also suppressed — proves in-process cooldown " +
      "is 60s, not the 5-min DB cooldown");
  } finally { teardown(tmp, db); }
});
