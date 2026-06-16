import { existsSync, readdirSync } from "node:fs";
import { basename, join, relative } from "node:path";
import { spawnSync } from "node:child_process";
import {
  rowGet, rowUpdate, setLastError,
  autoRequeueDev, resetDevRetries,
  sessionFinish, sessionsActive, projectGetByName,
  appendCycleLog,
} from "../pipeline-db/index.mjs";
import { gitWorktreeClean, sessionTypeFromNotes } from "./spawn.mjs";
import { detectDefaultBranch } from "../../src/cli/helpers.mjs";
import { featureWorktreePath, reportPath, resolveRowBranch } from "../worktree-paths.mjs";
import { publishNotification } from "../publisher.mjs";
import { generateSessionFile } from "../session-gen.mjs";
import { pidAlive } from "./state-file.mjs";

function appendNote(existing, note) {
  return existing ? `${existing} ${note}` : note;
}

function notifyFailure(project, feature, reason, { dryRun = false } = {}) {
  let title, msg;
  if (!reason) {
    title = `Spawn Failed: ${feature}`;
    msg = `Dev session spawn failed for '${feature}' in ${project}.\nStage reverted to queued with [spawn-failed] note.`;
  } else {
    // Stage-from-reason: derive the session-type prefix from the parked note
    // so a "dev-no-handoff" doesn't get titled "Review Park", etc.
    const stage = reason.startsWith("dev-") ? "Dev"
                : reason.startsWith("review-") ? "Review"
                : reason.startsWith("test-") ? "Test"
                : "Session";
    title = `${stage} Park: ${feature} (${reason})`;
    msg = (
      `${stage} session for '${feature}' in ${project} parked at manual.\n` +
      `Reason: ${reason}\n` +
      `Operator: inspect the spawn worktree / code-review worktree and re-queue if recoverable.`
    );
  }
  publishNotification({ title, message: msg, priority: "high" }, { dryRun }).catch(() => {});
}

function branchHasCommits(projectRoot, branch, targetBranch) {
  try {
    const r = spawnSync("git", ["-C", projectRoot, "rev-list", "--count", `${targetBranch}..${branch}`],
      { encoding: "utf8", windowsHide: true });
    return r.status === 0 && parseInt(r.stdout.trim(), 10) > 0;
  } catch { return false; }
}

// Auto-commit any staged/unstaged changes sitting in a feature worktree so
// the no-handoff recovery path can see them via branchHasCommits. Best-effort:
// any failure logs at WARN and returns false — never throws.
export function autoCommitWorktree(wtPath, feature, ts, logFn) {
  if (!wtPath || !existsSync(wtPath) || !existsSync(join(wtPath, ".git"))) {
    return false;
  }
  try {
    const status = spawnSync("git", ["-C", wtPath, "status", "--porcelain"],
      { encoding: "utf8", windowsHide: true, timeout: 30000 });
    if (status.status !== 0) {
      logFn(`[auto-commit] ${feature} status failed: ${(status.stderr || "").trim()}`, "WARN");
      return false;
    }
    if (!status.stdout.trim()) {
      return false; // nothing to commit
    }
    const add = spawnSync("git", ["-C", wtPath, "add", "-A"],
      { encoding: "utf8", windowsHide: true, timeout: 30000 });
    if (add.status !== 0) {
      logFn(`[auto-commit] ${feature} add failed: ${(add.stderr || "").trim()}`, "WARN");
      return false;
    }
    const commit = spawnSync("git", [
      "-C", wtPath, "commit", "--no-gpg-sign",
      "-m", `wip: reaper auto-commit [dev-no-handoff ${ts}]`,
    ], {
      encoding: "utf8", windowsHide: true, timeout: 30000,
      env: { ...process.env, GIT_AUTHOR_NAME: "Pipeline Reaper", GIT_AUTHOR_EMAIL: "reaper@pipeline",
        GIT_COMMITTER_NAME: "Pipeline Reaper", GIT_COMMITTER_EMAIL: "reaper@pipeline" },
    });
    if (commit.status !== 0) {
      logFn(`[auto-commit] ${feature} commit failed: ${(commit.stderr || "").trim()}`, "WARN");
      return false;
    }
    logFn(`[auto-commit] ${feature} committed worktree changes before recovery decision`, "INFO");
    return true;
  } catch (e) {
    logFn(`[auto-commit] ${feature} unexpected error: ${e.message}`, "WARN");
    return false;
  }
}

// Reconcile sessions based on process state (DB-driven, no activeProcs).
// Iterate active sessions; for each with a dead pid, mark finished and
// apply recovery logic based on the row's stage and session type.
export function reconcileSessions(db, { logFn, dryRun = false }) {
  const activeSessions = sessionsActive(db);
  const finished = activeSessions.filter(sess => !pidAlive(sess.pid));

  for (const sess of finished) {
    const project       = sess.project;
    const feature       = sess.feature || "unknown";
    const correlationId = sess.correlation_id || null;
    const stype         = sess.session_type || null;
    const projectRoot   = projectGetByName(db, project)?.root_path ?? null;
    const startTime     = sess.spawn_time || null;
    const endTime       = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
    const durationSecs  = startTime ? (Date.parse(endTime) - Date.parse(startTime)) / 1000 : null;

    if (correlationId) {
      try { sessionFinish(db, correlationId); }
      catch (e) { logFn(`[${project}] warning: failed to mark session finished: ${e.message}`, "WARN"); }
    }

    // Resolved session type — prefer row notes if stype not stamped on session.
    let resolvedStype = stype;
    if (!resolvedStype) {
      try {
        const row = rowGet(db, project, feature);
        resolvedStype = row ? sessionTypeFromNotes(row.notes_extra || "") : "dev";
      } catch { resolvedStype = "dev"; }
    }
    resolvedStype = resolvedStype || "dev";

    let row;
    try {
      row = rowGet(db, project, feature);
    } catch {
      logFn(`[${project}] failed to read row for '${feature}' — skipping reconcile`, "ERROR");
      continue;
    }

    let outcome = "fail"; // Dead pid always indicates failure/orphan
    const ts = new Date().toISOString().slice(0, 16);

    // Check if row already advanced past this session's stage (handoff recorded).
    // If so, session is done — nothing to do.
    const sessionStage = resolvedStype === "merge" ? "merge"
                       : resolvedStype === "review" ? "review"
                       : resolvedStype === "test" ? "test"
                       : "dev";

    if (row && row.stage !== sessionStage) {
      logFn(
        `[${project}] ${sessionStage} '${feature}' pid dead; row already at stage=${row.stage} ` +
        `(handoff recorded) — no action`
      );
    } else {
      // Row stage matches session stage — session is orphaned/no-handoff
      logFn(`[${project}] session '${feature}' pid dead; row still at stage=${sessionStage} — applying recovery`, "WARN");

      if (resolvedStype === "test") {
        try {
          if (row) {
            const qaPass = row.qa_pass;
            if (qaPass === 0) {
              const retries = row.dev_retries || 0;
              const budget = row.dev_retry_budget || 2;
              if (retries < budget) {
                autoRequeueDev(db, project, feature, retries + 1);
                outcome = "retry";
                logFn(`[${project}] test failed — auto-requeueing for dev (attempt ${retries + 1}/${budget})`);
              } else {
                logFn(`[${project}] test failed ${budget + 1} times — parking at test for human review`, "WARN");
              }
            } else if (qaPass === 1) {
              resetDevRetries(db, project, feature);
              logFn(`[${project}] test passed — cleared dev_retries`);
            }
          }
        } catch (e) {
          logFn(`[${project}] test-reaper update failed: ${e.message}`, "ERROR");
        }

      } else if (resolvedStype === "review") {
        if (!projectRoot) {
          logFn(`[${project}] review-reaper: no projectRoot known — skipping`, "WARN");
        } else if (row) {
          try {
            const planStem = basename(row.plan_file || "", ".md") || "";
            const spawnWt  = featureWorktreePath({ project, projectRoot, feature: planStem });
            const existing = row.notes_extra || "";

            if (!gitWorktreeClean(spawnWt, logFn)) {
              logFn(`[${project}] review '${feature}' pid dead but worktree dirty — parking at manual`, "ERROR");
              rowUpdate(db, project, feature, {
                stage:       "manual",
                notes_extra: appendNote(existing, `[review-touched-source ${ts}]`),
              });
              notifyFailure(project, feature, "review-touched-source", { dryRun });
            } else {
              const retryN = row.review_retries || 0;
              const { dir: reportsDir, glob: pattern } = reportPath({
                kind: "code-review", project, projectRoot, feature, retryN,
              });
              let hasReport = false;
              if (existsSync(reportsDir)) {
                try {
                  hasReport = readdirSync(reportsDir).some((file) => pattern.test(file));
                } catch {}
              }
              const note = hasReport ? "[review-stuck-cli-failed]" : "[review-stuck-no-report]";
              logFn(`[${project}] review '${feature}' pid dead, no verdict — parking at manual ${note}`, "ERROR");
              rowUpdate(db, project, feature, {
                stage:       "manual",
                notes_extra: appendNote(existing, `${note} ${ts}`),
              });
              notifyFailure(project, feature, note, { dryRun });
            }
          } catch (e) {
            logFn(`[${project}] review-reaper update failed: ${e.message}`, "ERROR");
          }
        }

      } else if (resolvedStype === "dev") {
        if (!row || row.stage !== "dev") {
          // No recovery needed — row already advanced past dev stage
        } else {
          try {
            const existing    = row.notes_extra || "";
            const retries     = row.review_retries || 0;
            const budget      = row.review_retry_budget || 3;
            const planStem    = basename(row.plan_file || "", ".md") || feature;
            const targetBranch = row.target_branch || detectDefaultBranch(projectRoot);
            // Auto-commit any uncommitted WIP in the feature worktree so
            // branchHasCommits sees the work. Best-effort — never blocks recovery.
            if (projectRoot) {
              const wtPath = featureWorktreePath({ project, projectRoot, feature: planStem });
              autoCommitWorktree(wtPath, planStem, ts, logFn);
            }
            const hasWork     = branchHasCommits(projectRoot, resolveRowBranch(row, planStem), targetBranch);
            const recoverable = !!projectRoot && retries < budget && (retries > 0 || hasWork);

            if (recoverable) {
              try {
                const cwd      = featureWorktreePath({
                  project, projectRoot, feature: planStem,
                });
                const sessionPath = generateSessionFile(project, row.plan_file, "review", {
                  projectRoot,
                  feature,
                  reviewRetries: retries,
                  branch: resolveRowBranch(row, planStem),
                  cwd,
                });
                const relPath = relative(projectRoot, sessionPath).replace(/\\/g, "/");
                // Replace notes write with stage-set to review; the next poll will spawn directly.
                const notes = `${existing}${existing ? " " : ""}${relPath} [dev-no-handoff-recovered ${ts}]`;
                rowUpdate(db, project, feature, {
                  stage:       "review",
                  notes_extra: notes,
                });
                logFn(
                  `[${project}] dev '${feature}' pid dead, no handoff — ` +
                  `recoverable (review_retries=${retries}/${budget}); ` +
                  `advancing to review`,
                  "WARN"
                );
              } catch (gerr) {
                logFn(
                  `[${project}] dev '${feature}' recovery failed (${gerr.message}) — parking at manual`,
                  "ERROR"
                );
                rowUpdate(db, project, feature, {
                  stage:       "manual",
                  notes_extra: appendNote(existing, `[dev-no-handoff-recovery-failed ${ts}]`),
                });
                notifyFailure(project, feature, "dev-no-handoff-recovery-failed", { dryRun });
              }
            } else {
              logFn(`[${project}] dev '${feature}' pid dead, no handoff — parking at manual`, "WARN");
              rowUpdate(db, project, feature, {
                stage:       "manual",
                notes_extra: appendNote(existing, `[dev-no-handoff ${ts}]`),
              });
              notifyFailure(project, feature, "dev-no-handoff", { dryRun });
            }
          } catch (e) {
            logFn(`[${project}] dev-reaper update failed: ${e.message}`, "ERROR");
          }
        }

      } else if (resolvedStype === "merge") {
        logFn(`[${project}] merge '${feature}' pid dead — parking at manual for triage`, "ERROR");
        if (row) {
          const existing = row.notes_extra || "";
          rowUpdate(db, project, feature, {
            stage:       "manual",
            notes_extra: appendNote(existing, `[merge-crashed ${ts}]`),
          });
          notifyFailure(project, feature, "merge-crashed", { dryRun });
        }
      }
    }

    // Cycle-log insert — one row per finished session. Spend is best-effort
    // from metric_sessions; absent join → null.
    try {
      let spendTokens = null;
      if (correlationId) {
        const row = db.prepare(
          "SELECT cache_create_tokens + cache_read_tokens AS total " +
          "FROM metric_sessions WHERE correlation_id = ? LIMIT 1"
        ).get(correlationId);
        spendTokens = row?.total ?? null;
      }
      appendCycleLog(db, {
        project,
        feature,
        stage:          resolvedStype,
        correlation_id: correlationId,
        start_time:     startTime,
        end_time:       endTime,
        duration_secs:  durationSecs,
        spend_tokens:   spendTokens,
        outcome,
      });
    } catch (e) {
      logFn(`[${project}] cycle_log insert failed: ${e.message}`, "WARN");
    }
  }
}
