import { test } from "node:test";
import { equal, ok, match } from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

process.env.PIPELINE_SUPPRESS_DEPRECATED = "1";

import { isProtectedBranch, spawnSession } from "../src/orchestrator/spawn.mjs";
import { connectPath, close } from "../src/db/connection.mjs";
import { projectAdd } from "../src/db/projects.mjs";
import { rowAdd, rowGet, rowUpdate } from "../src/db/rows.mjs";

// Hermetic stub — keep spawnSession's spawn-blocked notification off the real
// (Slack-forwarded) sink. See spawn-escalation.test.mjs.
const noopNotify = async () => true;

test("isProtectedBranch: true when branch equals target or default", () => {
  ok(isProtectedBranch("main", "main", "master"));
  ok(isProtectedBranch("master", "main", "master"));
});

test("isProtectedBranch: false for a distinct feature branch / empty", () => {
  ok(!isProtectedBranch("anm/x", "main", "master"));
  ok(!isProtectedBranch("", "main", "master"));
  ok(!isProtectedBranch(null, "main", "master"));
});

test("spawnSession: resolved branch == target parks at manual, returns null, never spawns", () => {
  const root = mkdtempSync(join(tmpdir(), "spawn-failsafe-"));
  try {
    spawnSync("git", ["init", "-q", "-b", "main"], { cwd: root, windowsHide: true });
    const plans = join(root, "plans");
    mkdirSync(plans, { recursive: true });
    const planFile = join(plans, "feat-x.md");
    writeFileSync(planFile, "# Plan\n\nbody\n");

    const db = connectPath(join(root, ".pipeline", "pipeline.db"));
    try {
      projectAdd(db, { name: "p", rootPath: root });
      rowAdd(db, "p", { feature: "feat-x", planFile, stage: "dev", branch: "main" });
      rowUpdate(db, "p", "feat-x", { notes_extra: "type=dev", target_branch: "main" });
      const row = rowGet(db, "p", "feat-x");

      const logs = [];
      const proc = spawnSession("p", row, "sessions/dev.md", root,
        { db, dryRun: false, logFn: (m, l) => logs.push({ m, l: l || "INFO" }), _publishNotification: noopNotify });

      equal(proc, null, "must not spawn a process");
      const after = rowGet(db, "p", "feat-x");
      equal(after.stage, "manual");
      match(after.notes_extra, /branch-equals-target/);
    } finally { close(db); }
  } finally { rmSync(root, { recursive: true, force: true, maxRetries: 3 }); }
});
