import { existsSync, readFileSync, writeFileSync, readdirSync, unlinkSync } from "node:fs";
import { join, basename, relative, isAbsolute, resolve } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import {
  close,
  rowGet, rowsList, rowAdd, rowUpdate, rowDelete,
  autoRequeueDevFromReview,
  loadCycleLog,
} from "../../scripts/pipeline-db/index.mjs";
import { generateSessionFile } from "../../scripts/session-gen.mjs";
import { publishNotification } from "../../scripts/publisher.mjs";
import { getFlag } from "./helpers.mjs";
import { handlerWorktreePath, orchestratorWorktreePath } from "../../scripts/worktree-paths.mjs";
import { lookupProjectOrFail } from "./project-lookup.mjs";

function formatRow(r) {
  const qa = r.qa_pass;
  return {
    feature:             r.feature,
    plan_file:           r.plan_file,
    branch:              r.branch || "—",
    stage:               r.stage,
    r_model:             r.r_model || "—",
    d_model:             r.d_model || "—",
    q_model:             r.q_model || "—",
    rvw_model:           r.rvw_model || "—",
    session_type:        r.session_type || "",
    session_file:        r.session_file || "",
    budget_usd:          r.budget_usd,
    qa_pass:             qa === 1 ? "true" : (qa === 0 ? "false" : "—"),
    dev_retries:         r.dev_retries || 0,
    review_retries:      r.review_retries ?? 0,
    review_retry_budget: r.review_retry_budget ?? 3,
    review_verdict:      r.review_verdict,
    spawn_failed:        Boolean(r.spawn_failed),
    notes:               r.notes_extra || "",
    rebase_required:     Boolean(r.rebase_required || 0),
    target_branch:       r.target_branch || "main",
    last_error:          r.last_error || null,
  };
}

const FOOTER = "\n" + ":black_small_square:".repeat(14) + "\n";

async function notify(title, message, priority = "default") {
  let tmpPath = null;
  try {
    tmpPath = join(tmpdir(), `pipeline-rows-notify-${process.pid}.txt`);
    writeFileSync(tmpPath, (message || "").trimEnd() + FOOTER, "utf8");
    const ok = await publishNotification({ title, messageFile: tmpPath, priority });
    return ok ? 0 : 1;
  } finally {
    if (tmpPath) try { unlinkSync(tmpPath); } catch {}
  }
}

function git(args, cwd) {
  return spawnSync("git", args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
}

function gitErrDetail(r) {
  const stderr = r.stderr ? r.stderr.toString() : "";
  const stdout = r.stdout ? r.stdout.toString() : "";
  return stderr || stdout || "(no output)";
}

function resolvePlansDir(raw, projectRoot, projectName) {
  const substituted = raw.replace(/\{project\}/g, projectName);
  return isAbsolute(substituted) ? substituted : resolve(projectRoot, substituted);
}

function backlogScan(db, project, plansDir) {
  let allRows;
  try { allRows = rowsList(db, project); } catch { return []; }
  const tracked = new Set(allRows.map(r => r.feature + ".md"));

  let candidates;
  try { candidates = readdirSync(plansDir).filter(f => f.endsWith(".md")); }
  catch { return []; }

  const allNames = new Set(candidates);
  const untracked = [];
  for (const name of [...candidates].sort()) {
    if (name.endsWith("-design.md") || name.endsWith("-test-plan.md")) continue;
    const stem = name.slice(0, -3);
    const isPhase = /-phase-\d+/.test(stem);
    if (!isPhase) {
      const escapedStem = stem.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      if ([...allNames].some(s => new RegExp(`^${escapedStem}-phase-\\d+`).test(s))) continue;
    }
    if (!tracked.has(name)) untracked.push(name);
  }
  return untracked;
}

// ── subcommands ────────────────────────────────────────────────────────────────

export async function run(cmd, argv) {

  // ── row-add ──────────────────────────────────────────────────────────────────
  if (cmd === "row-add") {
    const [project, feature, planFile, stage, ...flags] = argv;
    if (!project || !feature || !planFile || !stage) {
      process.stderr.write("usage: row-add <project> <feature> <plan-file> <stage>\n");
      return 1;
    }
    const ctx = lookupProjectOrFail(project);
    if (!ctx) return 1;

    const notes      = getFlag("--notes", flags) || "";
    const branch     = getFlag("--branch", flags) || "—";
    const rModel     = getFlag("--r-model", flags) || "—";
    const dModel     = getFlag("--d-model", flags) || "—";
    const qModel     = getFlag("--q-model", flags) || "—";
    const rvwModel   = getFlag("--rvw-model", flags) || "—";
    const dependsOn  = getFlag("--depends", flags) || null;
    const tgtBranch  = getFlag("--target-branch", flags) || "main";

    try {
      const existing = rowGet(ctx.db, ctx.project, feature);
      if (existing) {
        const updateFields = { stage };
        if (notes) updateFields.notes_extra = notes;
        if (branch && branch !== "—") updateFields.branch = branch;
        if (dependsOn) updateFields.depends_on = dependsOn;
        if (tgtBranch !== "main") updateFields.target_branch = tgtBranch;
        rowUpdate(ctx.db, ctx.project, feature, updateFields);
        process.stdout.write(`updated (existing row stage=${existing.stage} -> ${stage})\n`);
      } else {
        // queue-plan validates plan-file existence at intake (queue.mjs:233).
        // row-add is a lower-level entry point but the same invariant holds —
        // a row whose plan_file doesn't exist on disk will spawn an empty
        // session and park. Resolve using the same rules as queue-plan
        // (absolute / cwd-relative / project-plans-relative) for the check,
        // but preserve the as-passed storage semantics.
        const looksLikePath = planFile.includes("/") || planFile.includes("\\");
        const planPathCheck =
          isAbsolute(planFile) ? planFile
          : looksLikePath      ? resolve(process.cwd(), planFile)
          :                      join(ctx.projectRoot, "plans", planFile);
        if (!existsSync(planPathCheck)) {
          close(ctx.db);
          process.stderr.write(`plan file not found: ${planPathCheck}\n`);
          return 1;
        }
        rowAdd(ctx.db, ctx.project, {
          feature, planFile, stage, branch,
          rModel: rModel !== "—" ? rModel : null,
          dModel: dModel !== "—" ? dModel : null,
          qModel: qModel !== "—" ? qModel : null,
          rvwModel: rvwModel !== "—" ? rvwModel : null,
          dependsOn: dependsOn || null,
          targetBranch: tgtBranch,
        });
        if (notes) rowUpdate(ctx.db, ctx.project, feature, { notes_extra: notes });
        process.stdout.write("OK\n");
      }
      return 0;
    } finally { close(ctx.db); }
  }

  // ── rows ─────────────────────────────────────────────────────────────────────
  if (cmd === "rows") {
    const [project, ...flags] = argv;
    if (!project) { process.stderr.write("usage: rows <project>\n"); return 1; }
    const ctx = lookupProjectOrFail(project);
    if (!ctx) return 1;

    const fmt         = getFlag("--format", flags) || "json";
    const featureF    = getFlag("--feature", flags) || null;
    const excludeStages = [];
    for (let i = 0; i < flags.length; i++) {
      if (flags[i] === "--exclude-stage" && i + 1 < flags.length) {
        excludeStages.push(flags[i + 1]);
      }
    }

    try {
      const rawRows = rowsList(ctx.db, ctx.project, {
        featureFilter: featureF ? `%${featureF}%` : null,
        excludeStages: excludeStages.length ? excludeStages : null,
      }).map(formatRow);

      if (fmt === "json") {
        process.stdout.write(JSON.stringify(rawRows, null, 2) + "\n");
      } else if (fmt === "md") {
        const headers = ["#", "Stage", "Feature", "Branch", "Notes"];
        const colRows = rawRows.map((r, i) => [
          String(i + 1), r.stage, r.feature, r.branch || "—", r.notes || "",
        ]);
        const widths = headers.map((h, j) =>
          Math.max(h.length, ...colRows.map(r => r[j].length))
        );
        const mdRow = cells => "| " + cells.map((c, j) => c.padEnd(widths[j])).join(" | ") + " |";
        process.stdout.write(mdRow(headers) + "\n");
        process.stdout.write("| " + widths.map(w => "-".repeat(w)).join(" | ") + " |\n");
        for (const r of colRows) process.stdout.write(mdRow(r) + "\n");
      } else {
        for (const r of rawRows) {
          process.stdout.write(`${r.feature}\t${r.stage}\t${r.qa_pass}\n`);
        }
      }
      return 0;
    } finally { close(ctx.db); }
  }

  // ── cycle-log ──────────────────────────────────────────────────────────────────
  if (cmd === "cycle-log") {
    const [project, ...flags] = argv;
    if (!project) { process.stderr.write("usage: cycle-log <project> [--feature <slug>] [--limit N] [--format json|plain]\n"); return 1; }
    const ctx = lookupProjectOrFail(project);
    if (!ctx) return 1;
    const feature = getFlag("--feature", flags) || null;
    const limit   = parseInt(getFlag("--limit", flags) || "100", 10);
    const fmt     = getFlag("--format", flags) || "plain";
    try {
      const rows = loadCycleLog(ctx.db, { project: ctx.project, feature, limit });
      if (fmt === "json") {
        process.stdout.write(JSON.stringify(rows, null, 2) + "\n");
      } else {
        process.stdout.write("feature\tstage\tduration_secs\tspend_tokens\toutcome\tend_time\n");
        for (const r of rows) {
          const dur = r.duration_secs != null ? r.duration_secs.toFixed(1) : "—";
          const tok = r.spend_tokens   != null ? String(r.spend_tokens)     : "—";
          process.stdout.write(`${r.feature}\t${r.stage}\t${dur}\t${tok}\t${r.outcome ?? "—"}\t${r.end_time}\n`);
        }
      }
      return 0;
    } finally { close(ctx.db); }
  }

  // ── row-delete ────────────────────────────────────────────────────────────────
  if (cmd === "row-delete") {
    const [project, feature] = argv;
    if (!project || !feature) {
      process.stderr.write("usage: row-delete <project> <feature>\n");
      return 1;
    }
    const ctx = lookupProjectOrFail(project);
    if (!ctx) return 1;
    try {
      const ok = rowDelete(ctx.db, ctx.project, feature);
      if (ok) { process.stdout.write("OK\n"); return 0; }
      process.stderr.write(`not found: feature '${feature}'\n`);
      return 1;
    } finally { close(ctx.db); }
  }

  // ── backlog-scan ──────────────────────────────────────────────────────────────
  if (cmd === "backlog-scan") {
    const [project, _slot2, ..._rest] = argv;
    const plansDirArg = _slot2?.startsWith("--") ? undefined : _slot2;
    const flags = plansDirArg ? _rest : (_slot2 ? [_slot2, ..._rest] : _rest);
    if (!project) {
      process.stderr.write("usage: backlog-scan <project> [<plans-dir>]\n");
      return 1;
    }
    const ctx = lookupProjectOrFail(project);
    if (!ctx) return 1;
    let plansDir;
    if (plansDirArg) {
      plansDir = plansDirArg;
    } else {
      const { loadPipelineConfig } = await import("../pipeline-config.mjs");
      const cfg = loadPipelineConfig();
      plansDir = resolvePlansDir(cfg.plansDir || "plans", ctx.projectRoot, ctx.project);
    }
    if (!existsSync(plansDir)) { close(ctx.db); process.stderr.write(`not found: ${plansDir}\n`); return 1; }
    const fmt = getFlag("--format", flags) || "plain";
    try {
      const untracked = backlogScan(ctx.db, ctx.project, plansDir);
      if (fmt === "json") {
        process.stdout.write(JSON.stringify({ untracked, count: untracked.length }, null, 2) + "\n");
      } else {
        if (untracked.length) {
          process.stdout.write(`${untracked.length} plan(s) not in pipeline:\n`);
          for (const n of untracked) process.stdout.write(`  ${n}\n`);
        } else {
          process.stdout.write("0 plans not in pipeline\n");
        }
      }
      return 0;
    } finally { close(ctx.db); }
  }

  // ── backlog-sync ──────────────────────────────────────────────────────────────
  if (cmd === "backlog-sync") {
    const [project, ...flags] = argv;
    if (!project) { process.stderr.write("usage: backlog-sync <project>\n"); return 1; }
    const ctx = lookupProjectOrFail(project);
    if (!ctx) return 1;
    const plansDirArg = getFlag("--plans-dir", flags);
    let plansDir;
    if (plansDirArg) {
      plansDir = plansDirArg;
    } else {
      const { loadPipelineConfig } = await import("../pipeline-config.mjs");
      const cfg = loadPipelineConfig();
      plansDir = resolvePlansDir(cfg.plansDir || "plans", ctx.projectRoot, ctx.project);
    }
    if (!existsSync(plansDir)) { close(ctx.db); process.stdout.write("0 new backlog rows\n"); return 0; }
    let added = 0;
    try {
      const untracked = backlogScan(ctx.db, ctx.project, plansDir);
      for (const name of untracked) {
        const feature = basename(name, ".md");
        rowAdd(ctx.db, ctx.project, { feature, planFile: join(plansDir, name), stage: "backlog" });
        added++;
      }
    } finally { close(ctx.db); }
    process.stdout.write(added > 0 ? `Added ${added} backlog row(s)\n` : "0 new backlog rows\n");
    return 0;
  }

  // ── research-complete ─────────────────────────────────────────────────────────
  if (cmd === "research-complete") {
    const [project, researchFeature, devFeature, devPlanFile, ...flags] = argv;
    if (!project || !researchFeature || !devFeature || !devPlanFile) {
      process.stderr.write(
        "usage: research-complete <project> <research-feature> <dev-feature> <dev-plan-file>\n"
      );
      return 1;
    }
    const ctx = lookupProjectOrFail(project);
    if (!ctx) return 1;
    const notes  = getFlag("--notes", flags) || "";
    const rModel = getFlag("--r-model", flags) || "—";
    const dModel = getFlag("--d-model", flags) || "—";
    const qModel = getFlag("--q-model", flags) || "—";

    try {
      if (researchFeature === devFeature) {
        rowUpdate(ctx.db, ctx.project, researchFeature, { stage: "queued", ...(notes ? { notes_extra: notes } : {}) });
      } else {
        rowUpdate(ctx.db, ctx.project, researchFeature, { stage: "done", notes_extra: "type=research" });
        rowAdd(ctx.db, ctx.project, {
          feature: devFeature, planFile: devPlanFile, stage: "queued",
          rModel: rModel !== "—" ? rModel : null,
          dModel: dModel !== "—" ? dModel : null,
          qModel: qModel !== "—" ? qModel : null,
        });
        if (notes) rowUpdate(ctx.db, ctx.project, devFeature, { notes_extra: notes });
      }
    } finally { close(ctx.db); }
    process.stdout.write("OK\n");
    return 0;
  }

  // ── test-complete ─────────────────────────────────────────────────────────────
  if (cmd === "test-complete") {
    const [project, feature, ...flags] = argv;
    if (!project || !feature) {
      process.stderr.write(
        "usage: test-complete <project> <feature> --branch-slug <slug> " +
        "--report <path> --qa-pass true|false --has-manual-tests true|false --title <text> --message <text>\n"
      );
      return 1;
    }
    const ctx = lookupProjectOrFail(project);
    if (!ctx) return 1;

    const branchSlug    = getFlag("--branch-slug", flags);
    const reportPath    = getFlag("--report", flags);
    const qaPassStr     = getFlag("--qa-pass", flags);
    const hasManualStr  = getFlag("--has-manual-tests", flags);
    const title         = getFlag("--title", flags);
    const message       = getFlag("--message", flags);
    const priority      = getFlag("--priority", flags) || "default";

    if (!branchSlug || !reportPath || !qaPassStr || !hasManualStr || !title || !message) {
      close(ctx.db);
      process.stderr.write("test-complete: missing required flags\n");
      return 1;
    }
    if (!existsSync(reportPath)) {
      close(ctx.db);
      await notify(`Test Handoff Failed: ${feature} — report missing`,
        `Test report not found at ${reportPath}\n\nPlease check the path and re-run.`, "high");
      return 2;
    }

    const qaPass       = qaPassStr === "true";
    const hasManual    = hasManualStr === "true";
    const targetStage  = qaPass ? (hasManual ? "manual" : "merge") : "test";

    // Step 3: commit report on qa worktree
    const qaWorktree = handlerWorktreePath({ project: ctx.project, projectRoot: ctx.projectRoot, kind: "qa-test", feature: branchSlug });
    if (existsSync(qaWorktree)) {
      const corrId = process.env.CORRELATION_ID || "unknown";
      const passFail = qaPass ? "pass" : "fail";
      const commitMsg = `[${corrId}] Test report: ${feature} — ${passFail}`;
      try {
        const relReport = relative(qaWorktree, reportPath);
        let r = git(["add", relReport], qaWorktree);
        if (r.status !== 0) throw new Error(gitErrDetail(r));
        r = git(["commit", "-m", commitMsg], qaWorktree);
        if (r.status !== 0) throw new Error(gitErrDetail(r));
      } catch (e) {
        process.stderr.write(`WARNING: failed to commit report: ${e.message}\n`);
        await notify(`Test Handoff Failed: ${feature} — commit error`,
          `Failed to commit test report on qa worktree.\n\nWorktree: ${qaWorktree}\nError: ${e.message}`, "high");
        close(ctx.db);
        return 3;
      }
    } else {
      process.stderr.write(`WARNING: qa worktree not found at ${qaWorktree}; skipping commit\n`);
    }

    // Step 4: back-fill dev session file
    const sessionsDir = join(ctx.projectRoot, "sessions");
    if (existsSync(sessionsDir)) {
      try {
        const sessionFiles = readdirSync(sessionsDir)
          .filter(f => f.includes("dev") && f.includes(branchSlug) && f.endsWith(".md"));
        for (const f of sessionFiles) {
          const sfPath = join(sessionsDir, f);
          const content = readFileSync(sfPath, "utf8");
          const placeholder = "- **Test report:** *(to be filled by test session)*";
          const reportRef = `- **Test report:** \`test-reports/${basename(reportPath)}\``;
          if (content.includes(placeholder)) {
            writeFileSync(sfPath, content.replace(placeholder, reportRef), "utf8");
          }
        }
      } catch (e) {
        process.stderr.write(`WARNING: back-fill failed: ${e.message}\n`);
      }
    }

    // Step 5: set pipeline stage
    try {
      const fields = { stage: targetStage, qa_pass: qaPass ? 1 : 0 };
      const ok = rowUpdate(ctx.db, ctx.project, feature, fields);
      if (!ok) {
        process.stderr.write(`ERROR: failed to set pipeline stage for '${feature}'\n`);
        await notify(`Test Handoff Failed: ${feature} — stage-set error`,
          `Failed to advance pipeline to '${targetStage}'.`, "high");
        return 5;
      }
    } catch (e) {
      process.stderr.write(`ERROR: failed to set pipeline stage: ${e.message}\n`);
      await notify(`Test Handoff Failed: ${feature} — stage-set error`,
        `Failed to advance pipeline to '${targetStage}'.\n\nError: ${e.message}`, "high");
      return 5;
    } finally { close(ctx.db); }

    // Step 6: notify
    const rc = await notify(title, message, priority);
    if (rc !== 0) { process.stderr.write(`WARNING: notify returned ${rc}\n`); return 6; }
    return 0;
  }

  // ── review-complete ───────────────────────────────────────────────────────────
  if (cmd === "review-complete") {
    const [project, feature, ...flags] = argv;
    if (!project || !feature) {
      process.stderr.write(
        "usage: review-complete <project> <feature> --report <path> --verdict <v> " +
        "--title <text> --message <text>\n"
      );
      return 1;
    }
    const ctx = lookupProjectOrFail(project);
    if (!ctx) return 1;

    const reportPath    = getFlag("--report", flags);
    const verdict       = getFlag("--verdict", flags);
    const correlationId = getFlag("--correlation-id", flags) || "";
    const title         = getFlag("--title", flags);
    let message         = getFlag("--message", flags);
    const priority      = getFlag("--priority", flags) || "default";
    let notifyTitle     = title;
    let notifyPriority  = priority;

    if (!reportPath || !verdict || !title || !message) {
      close(ctx.db);
      process.stderr.write("review-complete: missing required flags\n");
      return 1;
    }

    if (!["ready_to_ship", "needs_work", "abort"].includes(verdict)) {
      const ts = new Date().toISOString().replace(/\.\d+Z$/, "Z");
      const badNote = `[review-bad-verdict ${ts}] '${verdict}'`;
      try { rowUpdate(ctx.db, ctx.project, feature, { stage: "queued", notes_extra: badNote }); }
      catch {} finally { close(ctx.db); }
      process.stderr.write(
        `ERROR: invalid verdict ${JSON.stringify(verdict)} — must be 'ready_to_ship', 'needs_work', or 'abort'\n`
      );
      await notify(`Review Failed: ${feature} — bad verdict`,
        `Verdict ${JSON.stringify(verdict)} rejected. Row reverted to queued with ${badNote}.`, "high");
      return 7;
    }

    if (!existsSync(reportPath)) {
      close(ctx.db);
      process.stderr.write(`ERROR: report not found at ${reportPath}\n`);
      await notify(`Review Failed: ${feature} — report missing`,
        `Report file not found at ${reportPath}\n\nCheck the path and re-run.`, "high");
      return 2;
    }

    let row;
    try { row = rowGet(ctx.db, ctx.project, feature); }
    catch (e) { close(ctx.db); throw e; }

    if (!row) {
      close(ctx.db);
      process.stderr.write(`ERROR: row not found for feature ${JSON.stringify(feature)}\n`);
      await notify(`Review Failed: ${feature} — row missing`,
        `Pipeline row not found for feature ${JSON.stringify(feature)}.`, "high");
      return 4;
    }
    // Short-circuit: another caller already won the verdict race AND the row
    // has progressed past the review stage (merge / queued for retry / done).
    // If the row is stuck at `manual` despite a verdict being set, an earlier
    // attempt set the verdict but the stage-advance step failed. We must NOT
    // short-circuit in that case — let this call attempt the advance again.
    if (row.review_verdict !== null && row.review_verdict !== undefined &&
        !["manual", "review"].includes(row.stage)) {
      close(ctx.db);
      process.stderr.write(
        `INFO: review_verdict already set to ${JSON.stringify(row.review_verdict)} for ${JSON.stringify(feature)} ` +
        `and row already at stage=${row.stage}; parallel call already won — exiting cleanly.\n`
      );
      return 0;
    }
    const reviewRetries      = row.review_retries ?? 0;
    const reviewRetryBudget  = row.review_retry_budget ?? 3;

    // Commit report on code-review worktree
    const worktree = handlerWorktreePath({ project: ctx.project, projectRoot: ctx.projectRoot, kind: "code-review", feature });
    if (existsSync(worktree)) {
      const commitMsg = `[${correlationId}] Review report: ${feature} — ${verdict}`;
      try {
        const relReport = relative(worktree, reportPath);
        let r = git(["add", relReport], worktree);
        if (r.status !== 0) throw new Error(gitErrDetail(r));
        r = git(["commit", "-m", commitMsg], worktree);
        if (r.status !== 0) {
          const detail = gitErrDetail(r);
          if (detail.includes("nothing to commit")) {
            close(ctx.db);
            process.stderr.write("INFO: report already committed by a parallel call; exiting cleanly.\n");
            return 0;
          }
          throw new Error(detail);
        }
      } catch (e) {
        process.stderr.write(`WARNING: failed to commit report: ${e.message}\n`);
        await notify(`Review Failed: ${feature} — commit error`,
          `Failed to commit report on code-review worktree.\n\nWorktree: ${worktree}\nError: ${e.message}`, "high");
        close(ctx.db);
        return 3;
      }
    } else {
      process.stderr.write(`WARNING: code-review worktree not found at ${worktree}; skipping commit\n`);
    }

    // Branch on verdict
    try {
      if (verdict === "ready_to_ship") {
        const ok = rowUpdate(ctx.db, ctx.project, feature, { stage: "merge", review_verdict: "ready_to_ship", review_retries: 0, qa_pass: 1 });
        if (!ok) {
          process.stderr.write(`ERROR: stage-set failed\n`);
          await notify(`Review Failed: ${feature} — stage-set error`,
            `Failed to advance to merge stage.`, "high");
          return 6;
        }
      } else if (verdict === "abort") {
        const ts = new Date().toISOString().replace(/\.\d+Z$/, "Z");
        const abortNote = `[review-abort ${ts}] approach rejected — human review required`;
        const ok = rowUpdate(ctx.db, ctx.project, feature, {
          stage: "manual", notes_extra: abortNote, review_verdict: "abort", qa_pass: 0,
        });
        if (!ok) {
          process.stderr.write(`ERROR: stage-set to manual failed\n`);
          await notify(`Review Aborted: ${feature} — stage-set error`,
            `Failed to park row at manual after abort verdict.`, "high");
          return 9;
        }
        notifyTitle   = `Review Aborted: ${feature} — approach rejected`;
        notifyPriority = "high";
      } else if (reviewRetries + 1 < reviewRetryBudget) {
        const ok = autoRequeueDevFromReview(ctx.db, ctx.project, feature, reviewRetries);
        if (!ok) {
          process.stderr.write(
            `ERROR: CAS failed — review_retries changed between read and write ` +
            `(expected ${reviewRetries}); concurrent review-complete?\n`
          );
          await notify(`Review Failed: ${feature} — CAS conflict`,
            `Concurrent review-complete detected. Operator: check pipeline state for ${JSON.stringify(feature)}.`, "high");
          return 8;
        }
      } else {
        const ts = new Date().toISOString().replace(/\.\d+Z$/, "Z");
        const parkedNote = `[parked-review-budget-exhausted ${ts}]`;
        rowUpdate(ctx.db, ctx.project, feature, {
          stage: "manual", notes_extra: parkedNote,
          review_verdict: "needs_work", review_retries: reviewRetries + 1, qa_pass: 0,
        });
        notifyTitle    = `Review Parked: ${feature} — budget exhausted (${reviewRetries + 1}/${reviewRetryBudget})`;
        notifyPriority  = "high";
      }
    } finally { close(ctx.db); }

    const rc = await notify(notifyTitle, message, notifyPriority);
    if (rc !== 0) { process.stderr.write(`WARNING: notify returned ${rc}\n`); return 10; }
    return 0;
  }

  // ── dev-complete ──────────────────────────────────────────────────────────────
  if (cmd === "dev-complete") {
    const [project, planFile, feature, ...flags] = argv;
    if (!project || !planFile || !feature) {
      process.stderr.write(
        "usage: dev-complete <project> <plan-file> <feature> --title <text> --message <text>\n"
      );
      return 1;
    }
    const ctx = lookupProjectOrFail(project);
    if (!ctx) return 1;

    const title         = getFlag("--title", flags);
    const message       = getFlag("--message", flags);
    const priority      = getFlag("--priority", flags) || "default";

    if (!title || !message) {
      close(ctx.db);
      process.stderr.write("dev-complete: missing required flags\n");
      return 1;
    }

    let sessionPath;
    try {
      // Pass review_retries so the review-session template can stamp the
      // retry number into its report filename — each retry gets its own
      // report file so prior verdicts remain readable as history.
      const devCompleteRow = rowGet(ctx.db, ctx.project, feature);
      const planStem = (planFile || "").replace(/\.md$/, "").split(/[\\/]/).pop();
      const cwd = orchestratorWorktreePath({
        project: ctx.project, projectRoot: ctx.projectRoot, branch: `autonomous/${planStem}`,
      });
      sessionPath = generateSessionFile(ctx.project, planFile, "review", {
        projectRoot: ctx.projectRoot,
        feature,
        reviewRetries: devCompleteRow?.review_retries ?? 0,
        cwd,
      });
    } catch (e) {
      close(ctx.db);
      process.stderr.write(`ERROR: session-generate failed: ${e.message}\n`);
      await notify(`Dev Handoff Failed: ${feature}`,
        `Session generation failed: ${e.message}`, "high");
      return 2;
    }

    const relPath = relative(ctx.projectRoot, sessionPath).replace(/\\/g, "/");
    const notes = `type=review ${relPath}`;

    try {
      const ok = rowUpdate(ctx.db, ctx.project, feature, { stage: "queued", notes_extra: notes });
      if (!ok) {
        process.stderr.write(`ERROR: stage-set failed for feature '${feature}'\n`);
        await notify(`Dev Handoff Failed: ${feature}`,
          `Pipeline update failed (row not found). Session file created at ${sessionPath}`, "high");
        return 3;
      }
    } finally { close(ctx.db); }

    const rc = await notify(title, message, priority);
    if (rc !== 0) { process.stderr.write(`WARNING: notify failed with exit code ${rc}\n`); return 4; }
    return 0;
  }

  return null;
}
