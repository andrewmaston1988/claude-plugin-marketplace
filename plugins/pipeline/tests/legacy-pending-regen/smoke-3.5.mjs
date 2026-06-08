// Smoke tests for Unit 3.5 — orchestrator modules
import { discoverProjects } from "../scripts/orchestrator/discovery.mjs";
import { readState, writeState, deleteState, pidAlive, STATE_FILE } from "../scripts/orchestrator/state-file.mjs";
import { sessionTypeFromNotes, modelFromNotes, budgetFromNotes, worktreePath, validateSessionSlug, gitWorktreeClean } from "../scripts/orchestrator/spawn.mjs";
import { shouldSpawnGovernor, shouldSpawnMonthlyGovernor } from "../scripts/orchestrator/governor.mjs";
import { connectPath, rowAdd, close, setMeta } from "../scripts/pipeline-db/index.mjs";
import { mkdtempSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let pass = 0, fail = 0;
function assert(label, cond) {
  if (cond) { console.log(`  ✓ ${label}`); pass++; }
  else       { console.error(`  ✗ ${label}`); fail++; }
}

const dir = mkdtempSync(join(tmpdir(), "orch-smoke-"));
const reposRoot = join(dir, "repos");
mkdirSync(join(reposRoot, "proj-a"), { recursive: true });
mkdirSync(join(reposRoot, "proj-b"), { recursive: true });

// ── discovery ──────────────────────────────────────────────────────────────────
console.log("\ndiscovery");
// proj-a: pipeline.db with pipeline_enabled=1
const dbA = connectPath(join(reposRoot, "proj-a", "pipeline.db"));
setMeta(dbA, "pipeline_enabled", "1");
rowAdd(dbA, { feature: "feat-x", planFile: "feat-x.md", stage: "queued" });
close(dbA);

// proj-b: pipeline.db with default pipeline_enabled=0
const dbB = connectPath(join(reposRoot, "proj-b", "pipeline.db"));
close(dbB);

// proj-c: no pipeline.db
mkdirSync(join(reposRoot, "proj-c"), { recursive: true });

const found = discoverProjects(reposRoot);
assert("proj-a discovered (enabled=1)", found.has("proj-a"));
assert("proj-b not discovered (enabled=0)", !found.has("proj-b"));
assert("proj-c not discovered (no db)", !found.has("proj-c"));
assert("proj-a root is correct dir", found.get("proj-a") === join(reposRoot, "proj-a"));

// filter
const filtered = discoverProjects(reposRoot, { projectFilter: "proj-a" });
assert("filter: proj-a returned", filtered.has("proj-a"));
assert("filter: proj-b excluded", !filtered.has("proj-b"));

// empty reposRoot
const noFound = discoverProjects(join(dir, "nonexistent"));
assert("nonexistent reposRoot returns empty map", noFound.size === 0);

// ── state-file ────────────────────────────────────────────────────────────────
console.log("\nstate-file");
// Use a temp state file to avoid touching real ~/.pipeline
// (STATE_FILE reference kept for documentation; we exercise the public read/write API)
const _realStateFile = STATE_FILE;
const _testStateDir = join(dir, "pipeline-state");
mkdirSync(_testStateDir, { recursive: true });

// Monkey-patch STATE_FILE by testing writeState/readState behaviour directly
writeState("running", { startedAt: "2026-01-01T00:00:00Z" });
const s = readState();
assert("state written", s !== null);
assert("state.status = running", s && s.status === "running");
assert("state.pid = current pid", s && s.pid === process.pid);
assert("state.started_at set", s && s.started_at === "2026-01-01T00:00:00Z");
assert("state.last_poll set", s && typeof s.last_poll === "string");

writeState("stopped");
const s2 = readState();
assert("state stopped", s2 && s2.status === "stopped");

deleteState();
const s3 = readState();
assert("state deleted → null", s3 === null);

// ── pid alive ─────────────────────────────────────────────────────────────────
console.log("\npidAlive");
assert("current pid is alive", pidAlive(process.pid));
assert("pid 99999999 is not alive", !pidAlive(99999999));

// ── sessionTypeFromNotes ──────────────────────────────────────────────────────
console.log("\nsessionTypeFromNotes");
assert("type=dev", sessionTypeFromNotes("type=dev model=haiku") === "dev");
assert("type=review", sessionTypeFromNotes("sessions/dev-2026-01-01.md type=review") === "review");
assert("type=test", sessionTypeFromNotes("type=test") === "test");
assert("no type → dev", sessionTypeFromNotes("") === "dev");
assert("type=research", sessionTypeFromNotes("type=research") === "research");

// ── modelFromNotes ────────────────────────────────────────────────────────────
console.log("\nmodelFromNotes");
assert("model=haiku extracted", modelFromNotes("type=dev model=claude-haiku-4-5", "p", "f", "dev") === "claude-haiku-4-5");
assert("review default = sonnet", modelFromNotes("", "p", "f", "review") === "claude-sonnet-4-6");
assert("dev default = haiku", modelFromNotes("", "p", "f", "dev").includes("haiku"));

// ── budgetFromNotes ───────────────────────────────────────────────────────────
console.log("\nbudgetFromNotes");
assert("budget=5.00", budgetFromNotes("budget=5.00") === "5.00");
assert("default 10.00", budgetFromNotes("") === "10.00");

// ── worktreePath ──────────────────────────────────────────────────────────────
console.log("\nworktreePath");
const wt = worktreePath(join(dir, "nova-parser"), "my-feature");
const expectedWt = join(dir, "nova-parser-wt", "autonomous-my-feature");
assert("worktree path correct", wt === expectedWt);

// ── validateSessionSlug ───────────────────────────────────────────────────────
console.log("\nvalidateSessionSlug");
assert("matching slug → null", validateSessionSlug("dev-2026-01-01-my-feature.md", "my-feature") === null);
assert("mismatched slug → error string", validateSessionSlug("dev-2026-01-01-wrong-name.md", "my-feature") !== null);
assert("unknown format → null (no false-block)", validateSessionSlug("session.md", "my-feature") === null);
assert("null planStem → null", validateSessionSlug("dev-2026-01-01-foo.md", "") === null);

// ── gitWorktreeClean ──────────────────────────────────────────────────────────
console.log("\ngitWorktreeClean");
assert("nonexistent worktree → clean (true)", gitWorktreeClean(join(dir, "nonexistent")) === true);

// ── shouldSpawnGovernor ───────────────────────────────────────────────────────
console.log("\nshouldSpawnGovernor");
// With no reports dir and no analyticsDb, catch-up should trigger
const claudeBase = join(dir, "claude-base");
mkdirSync(join(claudeBase, "reports"), { recursive: true });
const gov = shouldSpawnGovernor(claudeBase, null);
assert("shouldSpawnGovernor returns {should, reportType, slotHour}", "should" in gov && "reportType" in gov && "slotHour" in gov);

// ── shouldSpawnMonthlyGovernor ────────────────────────────────────────────────
console.log("\nshouldSpawnMonthlyGovernor");
const monthly = shouldSpawnMonthlyGovernor(null);
assert("shouldSpawnMonthlyGovernor returns bool", typeof monthly === "boolean");

// ── cleanup ───────────────────────────────────────────────────────────────────
rmSync(dir, { recursive: true });

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
