import { test } from "node:test";
import { strictEqual, match, ok } from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

process.env.PIPELINE_SUPPRESS_DEPRECATED = "1";

import { connectPath, close } from "../src/db/connection.mjs";
import { projectAdd } from "../src/db/projects.mjs";
import { rowAdd } from "../src/db/rows.mjs";
import { reconcileSessions } from "../src/orchestrator/reaper.mjs";

const DEAD_PID = 999999;
function git(cwd, ...args) {
  const r = spawnSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", ...args],
    { cwd, encoding: "utf8", windowsHide: true });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${r.stderr}`);
  return r.stdout;
}

test("reaper: dev-no-handoff recovers when a CUSTOM branch carries commits", () => {
  const root = mkdtempSync(join(tmpdir(), "reaper-custom-"));
  try {
    // Real repo: main + a custom branch with a commit ahead. NB: autonomous/feat-x
    // intentionally does NOT exist — the old code would look there and find nothing.
    git(root, "init", "-q", "-b", "main");
    git(root, "commit", "--allow-empty", "-m", "init");
    git(root, "checkout", "-q", "-b", "anm/custom_x");
    writeFileSync(join(root, "f.txt"), "work\n");
    git(root, "add", "f.txt");
    git(root, "commit", "-m", "feature work");

    const plans = join(root, "plans");
    mkdirSync(plans, { recursive: true });
    const planFile = join(plans, "feat-x.md");
    writeFileSync(planFile, "# Plan\n\nbody\n");

    const db = connectPath(join(root, ".pipeline", "pipeline.db"));
    try {
      projectAdd(db, { name: "p", rootPath: root });
      rowAdd(db, "p", { feature: "feat-x", planFile, stage: "dev", branch: "anm/custom_x" });
      db.prepare(
        "UPDATE pipeline_rows SET notes_extra=?, target_branch=?, review_retries=?, review_retry_budget=? " +
        "WHERE project=? AND feature=?"
      ).run("", "main", 0, 3, "p", "feat-x");
      db.prepare(
        "INSERT INTO sessions (correlation_id, project, feature, session_type, cwd, session_file, spawn_time, pid, is_active) " +
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1)"
      ).run("corr-x", "p", "feat-x", "dev", root, "sessions/dev.md", new Date().toISOString(), DEAD_PID);

      const logs = [];
      reconcileSessions(db, { logFn: (m, l) => logs.push({ m, l: l || "INFO" }), dryRun: true });

      const row = db.prepare(
        "SELECT stage, notes_extra FROM pipeline_rows WHERE project=? AND feature=?"
      ).get("p", "feat-x");
      strictEqual(row.stage, "review", "custom-branch commits should advance directly to review");
      match(row.notes_extra, /dev-no-handoff-recovered/);

      // Handoff threading: the generated review session carries the custom branch.
      const rel = row.notes_extra.split(/\s+/).find(t => t.endsWith(".md"));
      ok(rel, "recovery wrote a review session path into notes_extra");
      const content = readFileSync(join(root, rel), "utf8");
      match(content, /anm\/custom_x/);
    } finally { close(db); }
  } finally { rmSync(root, { recursive: true, force: true, maxRetries: 3 }); }
});
