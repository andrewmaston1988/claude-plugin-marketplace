import { existsSync, readdirSync } from "node:fs";
import { join, basename, relative } from "node:path";
import {
  rowGet, rowUpdate, setLastError,
  autoRequeueDev, resetDevRetries,
  sessionFinish,
  projectGetByName,
  appendCycleLog,
} from "../pipeline-db/index.mjs";
import { gitWorktreeClean, sessionTypeFromNotes } from "./spawn.mjs";
import { orchestratorWorktreePath } from "../worktree-paths.mjs";
import { publishNotification } from "../publisher.mjs";
import { generateSessionFile } from "../session-gen.mjs";

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

// Reap finished orchestrator child processes. Takes the unified DB handle;
// project + projectRoot are read from each proc's _project / _projectRoot tags
// stamped at spawn time. `dryRun` propagates to notifyFailure so tests can
// exercise reap logic without spamming the real notifications dir / Slack.
export function reapFinished(activeProcs, db, { logFn, dryRun = false }) {
  const finished = [];
  for (const [project, proc] of activeProcs) {
    if (proc.exitCode !== null) finished.push(project);
  }

  for (const project of finished) {
    const proc = activeProcs.get(project);
    activeProcs.delete(project);

    const rc            = proc.exitCode;
    const feature       = proc._feature || "unknown";
    const correlationId = proc._correlationId || null;
    const stype         = proc._stype || null;
    const projectRoot   = proc._projectRoot || (projectGetByName(db, project)?.root_path ?? null);
    const startTime     = proc._startTime || null;
    const endTime       = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
    const durationSecs  = startTime ? (Date.parse(endTime) - Date.parse(startTime)) / 1000 : null;

    if (correlationId) {
      try { sessionFinish(db, correlationId); }
      catch (e) { logFn(`[${project}] warning: failed to mark session finished: ${e.message}`, "WARN"); }
    }

    // Resolved session type — fall back to row notes if not stamped on proc.
    // `outcome` defaults to pass/fail by exit code; the test-requeue branch
    // below flips it to "retry" when applicable.
    let resolvedStype = stype;
    if (!resolvedStype) {
      try {
        const row = rowGet(db, project, feature);
        resolvedStype = row ? sessionTypeFromNotes(row.notes_extra || "") : "dev";
      } catch { resolvedStype = "dev"; }
    }
    resolvedStype = resolvedStype || "dev";
    let outcome = rc === 0 ? "pass" : "fail";

    if (rc !== 0) {
      const crashNote = resolvedStype === "review" ? "[review-crashed]" : "[spawn-failed]";
      logFn(`[${project}] session '${feature}' exited ${rc} — reverting to queued`, "ERROR");

      try {
        const row = rowGet(db, project, feature);
        const existing = row ? (row.notes_extra || "") : "";
        setLastError(db, project, feature, `session exited ${rc}`);
        rowUpdate(db, project, feature, {
          stage:       "queued",
          notes_extra: appendNote(existing, crashNote),
        });
      } catch (e) {
        logFn(`[${project}] reaper update failed: ${e.message}`, "ERROR");
      }
      notifyFailure(project, feature, null, { dryRun });

    } else {
      logFn(`[${project}] session '${feature}' completed (exit 0)`);

      if (resolvedStype === "test") {
        try {
          const row = rowGet(db, project, feature);
          if (row) {
            const qaPass = row.qa_pass;
            if (qaPass === 0) {
              const retries = row.dev_retries || 0;
              if (retries < 2) {
                autoRequeueDev(db, project, feature, retries + 1);
                outcome = "retry";
                logFn(`[${project}] test failed — auto-requeueing for dev (attempt ${retries + 1}/2)`);
              } else {
                logFn(`[${project}] test failed 3 times — parking at test for human review`, "WARN");
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
          continue;
        }
        try {
          const row = rowGet(db, project, feature);
          if (!row) continue;

          if (row.stage !== "review") {
            logFn(
              `[${project}] review '${feature}' exit 0; row already at stage=${row.stage} (handled by review-complete) — no action`
            );
          } else {
            const planStem = basename(row.plan_file || "", ".md") || "";
            const spawnWt  = orchestratorWorktreePath({ project, projectRoot, branch: `autonomous/${planStem}` });
            const ts       = new Date().toISOString().slice(0, 16);
            const existing = row.notes_extra || "";

            if (!gitWorktreeClean(spawnWt, logFn)) {
              logFn(`[${project}] review '${feature}' exit 0 but worktree dirty — parking at manual`, "ERROR");
              rowUpdate(db, project, feature, {
                stage:       "manual",
                notes_extra: appendNote(existing, `[review-touched-source ${ts}]`),
              });
              notifyFailure(project, feature, "review-touched-source", { dryRun });
            } else {
              // Reports are written by the review session into
              // <spawnWt>/reports/review-report-<feature>-retry<N>.md per the
              // bundled review-session.md template. <N> is the row's current
              // review_retries (so each retry gets its own report and prior
              // verdicts stay browseable). The reaper checks the same path
              // for the current retry's report so an exit-0-without-review-
              // complete can distinguish "agent wrote a report but failed to
              // call review-complete" from "agent never produced a report".
              const retryN = row.review_retries || 0;
              const reportsDir = join(spawnWt, "reports");
              const reportFile = `review-report-${feature}-retry${retryN}.md`;
              let hasReport = false;
              if (existsSync(reportsDir)) {
                try {
                  hasReport = readdirSync(reportsDir).includes(reportFile);
                } catch {}
              }
              const note = hasReport ? "[review-stuck-cli-failed]" : "[review-stuck-no-report]";
              logFn(`[${project}] review '${feature}' exit 0 with no verdict — parking at manual ${note}`, "ERROR");
              rowUpdate(db, project, feature, {
                stage:       "manual",
                notes_extra: appendNote(existing, `${note} ${ts}`),
              });
              notifyFailure(project, feature, note, { dryRun });
            }
          }
        } catch (e) {
          logFn(`[${project}] review-reaper update failed: ${e.message}`, "ERROR");
        }

      } else if (resolvedStype === "dev") {
        // Dev sessions are expected to call `pipeline dev-complete` themselves
        // — that command sets stage=queued + notes_extra=type=review and the
        // orch then spawns the review session. If the session exited 0 but
        // didn't perform the handoff, two cases matter:
        //
        //   (a) Recoverable — the row is mid review-bounce cycle
        //       (review_retries > 0, budget remains). The agent likely
        //       self-aborted because its self-review still flagged a BLOCKER
        //       (per the dev template's "don't dev-complete with a known
        //       [BLOCKER] outstanding" rule) but committed work to the branch
        //       anyway. Advancing to review here uses an existing retry slot
        //       to let the reviewer judge the committed state. The budget
        //       naturally bounds the loop.
        //
        //       Note: we deliberately do NOT gate on review_verdict.
        //       `autoRequeueDevFromReview` clears the column to NULL on
        //       bounce (pipeline-db/rows.mjs:126, pipeline_db.py:416) so the
        //       next review cycle starts fresh — reading the verdict here
        //       always sees NULL. `review_retries > 0` is the reliable
        //       "we are in a bounce loop" signal.
        //
        //   (b) Terminal — either an initial dev that forgot the handoff
        //       (review_retries == 0), or budget exhausted (retries ==
        //       budget). Park at manual for human triage.
        try {
          const row = rowGet(db, project, feature);
          if (row && row.stage === "dev" && (row.notes_extra || "").startsWith("type=dev")) {
            const ts          = new Date().toISOString().slice(0, 16);
            const existing    = row.notes_extra || "";
            const retries     = row.review_retries || 0;
            const budget      = row.review_retry_budget || 3;
            const recoverable = retries > 0 && retries < budget && projectRoot;

            if (recoverable) {
              try {
                const planStem = basename(row.plan_file || "", ".md") || feature;
                const cwd      = orchestratorWorktreePath({
                  project, projectRoot, branch: `autonomous/${planStem}`,
                });
                const sessionPath = generateSessionFile(project, row.plan_file, "review", {
                  projectRoot,
                  feature,
                  reviewRetries: retries,
                  cwd,
                });
                const relPath = relative(projectRoot, sessionPath).replace(/\\/g, "/");
                const notes = `type=review sessions/${relPath} [dev-no-handoff-recovered ${ts}]`;
                rowUpdate(db, project, feature, {
                  stage:       "queued",
                  notes_extra: notes,
                });
                logFn(
                  `[${project}] dev '${feature}' exit 0 no handoff — ` +
                  `recoverable (review verdict=needs_work, retries=${retries}/${budget}); ` +
                  `advancing to review`,
                  "WARN"
                );
              } catch (gerr) {
                // Recovery failed (session-gen threw, worktree missing,
                // whatever) — fall back to park so the operator can triage.
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
              logFn(`[${project}] dev '${feature}' exit 0 but no handoff — parking at manual`, "WARN");
              rowUpdate(db, project, feature, {
                stage:       "manual",
                notes_extra: appendNote(existing, `[dev-no-handoff ${ts}]`),
              });
              notifyFailure(project, feature, "dev-no-handoff", { dryRun });
            }
          }
        } catch (e) {
          logFn(`[${project}] dev-reaper update failed: ${e.message}`, "ERROR");
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
