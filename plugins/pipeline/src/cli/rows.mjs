import { existsSync, readFileSync, writeFileSync, readdirSync, unlinkSync } from "node:fs";
import { join, basename, relative, isAbsolute, resolve } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import {
  close,
  rowGet, rowsList, rowAdd, rowUpdate, rowDelete,
  autoRequeueDevFromReview,
  loadCycleLog,
  planUpsert, plansFtsRebuild,
} from "../../scripts/pipeline-db/index.mjs";
import { generateSessionFile } from "../../scripts/session-gen.mjs";
import { publishNotification } from "../../scripts/publisher.mjs";
import { getFlag, formatRow } from "./helpers.mjs";
import { featureWorktreePath, resolveRowBranch } from "../../scripts/worktree-paths.mjs";
import { lookupProjectOrFail } from "./project-lookup.mjs";
import { resolvePlansDir, resolvePlanFile } from "../plans-resolver.mjs";
import { reclaimPlanIfMisplaced } from "../../scripts/plans/reclaim.mjs";

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

// Detect stale re-raises by comparing concern fingerprints across reports
async function detectStaleRaise(reportPath, worktreePath, publishBranch, reviewRetries, feature) {
  if (reviewRetries < 1) return "skip"; // no previous report to compare

  try {
    let currentConcerns = [];
    let prevConcerns = [];

    // Read current report
    if (existsSync(reportPath)) {
      const content = readFileSync(reportPath, "utf8");
      currentConcerns = extractConcernHeadings(content);
    } else {
      return "skip"; // can't read current
    }

    // Read previous report from publish branch
    const prevReportPath = reportPath.replace(
      new RegExp(`retry${reviewRetries}`, "g"),
      `retry${reviewRetries - 1}`
    );
    const relPath = relative(worktreePath, prevReportPath).replaceAll("\\", "/");
    const r = git(
      ["show", `${publishBranch}:${relPath}`],
      worktreePath
    );

    if (r.status === 0) {
      const prevContent = r.stdout.toString("utf8");
      prevConcerns = extractConcernHeadings(prevContent);
    } else {
      return "skip"; // can't read previous
    }

    if (currentConcerns.length === 0) return "none";
    if (prevConcerns.length === 0) return "none";

    // Fingerprint: first 80 chars of normalized heading text
    const fingerprint = (concern) =>
      concern.toLowerCase().replace(/\s+/g, " ").trim().substring(0, 80);

    const prevFingerprints = new Set(prevConcerns.map(fingerprint));
    const currentFingerprints = currentConcerns.map(fingerprint);

    const allMatch = currentFingerprints.every(fp => prevFingerprints.has(fp));
    if (allMatch) return "all_stale";

    const anyMatch = currentFingerprints.some(fp => prevFingerprints.has(fp));
    return anyMatch ? "partial" : "none";
  } catch (e) {
    // Never throw — detection is advisory
    return "skip";
  }
}

function extractConcernHeadings(content) {
  const lines = content.split("\n");
  const concerns = [];
  for (const line of lines) {
    if (/^\s*-\s+\*\*\[(BLOCKER|ADVISORY|ABORT)\]\*\*/.test(line)) {
      concerns.push(line.replace(/^\s*-\s+/, "").trim().slice(0, 80).toLowerCase());
    }
  }
  return concerns;
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
          :                      resolvePlanFile(planFile, { project: ctx.project, projectRoot: ctx.projectRoot });
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
      plansDir = resolvePlansDir({ project: ctx.project, projectRoot: ctx.projectRoot });
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
      plansDir = resolvePlansDir({ project: ctx.project, projectRoot: ctx.projectRoot });
    }
    if (!existsSync(plansDir)) { close(ctx.db); process.stdout.write("0 new backlog rows\n"); return 0; }
    let added = 0;
    try {
      const untracked = backlogScan(ctx.db, ctx.project, plansDir);
      for (const name of untracked) {
        const feature = basename(name, ".md");
        const filePath = join(plansDir, name);
        rowAdd(ctx.db, ctx.project, { feature, planFile: filePath, stage: "backlog" });
        added++;

        // Index plan content: extract title, branch, and full body.
        const body = readFileSync(filePath, "utf8");
        const titleMatch = body.match(/^#\s+(.+)/m);
        const title = titleMatch ? titleMatch[1].trim() : null;
        const branchMatch = body.match(/\*Branch:\*?\s*`?([^\s`*]+)`?/);
        const branch = branchMatch ? branchMatch[1] : null;

        planUpsert(ctx.db, {
          project: ctx.project,
          slug: feature,
          filePath,
          status: 'active',
          branch,
          title,
          body,
        });
      }
      // Rebuild FTS index once after all upserts.
      if (added > 0) {
        plansFtsRebuild(ctx.db);
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
    const publishBranch = getFlag("--publish-branch", flags) || "";

    if (!branchSlug || !reportPath || !qaPassStr || !hasManualStr || !title || !message) {
      close(ctx.db);
      process.stderr.write("test-complete: missing required flags\n");
      return 1;
    }
    // Phase 3b: report may live only on the publish side-branch after the dance.
    const qaWorktreeProbe = featureWorktreePath({ project: ctx.project, projectRoot: ctx.projectRoot, feature: branchSlug });
    const reportOnPublishBranch = !existsSync(reportPath)
      && publishBranch
      && existsSync(qaWorktreeProbe)
      && git(["cat-file", "-e", `${publishBranch}:${relative(qaWorktreeProbe, reportPath).replaceAll("\\","/")}`], qaWorktreeProbe).status === 0;
    if (!existsSync(reportPath) && !reportOnPublishBranch) {
      close(ctx.db);
      await notify(`Test Handoff Failed: ${feature} — report missing`,
        `Test report not found at ${reportPath} (and not on publish branch ${publishBranch || "<unset>"})\n\nPlease check the path and re-run.`, "high");
      return 2;
    }

    const qaPass       = qaPassStr === "true";
    const hasManual    = hasManualStr === "true";
    const targetStage  = qaPass ? (hasManual ? "manual" : "merge") : "test";

    // Step 3: commit report on qa worktree (or skip if dance already published).
    // Phase 3b: all session kinds share the single feature worktree. When the
    // session's stash-switchback dance already committed the report onto the
    // publish branch, the dev-branch working tree is clean and the helper's
    // add+commit becomes a no-op.
    const qaWorktree = qaWorktreeProbe;
    if (existsSync(qaWorktree) && !reportOnPublishBranch) {
      const corrId = process.env.CORRELATION_ID || "unknown";
      const passFail = qaPass ? "pass" : "fail";
      const commitMsg = `[${corrId}] Test report: ${feature} — ${passFail}`;
      try {
        const relReport = relative(qaWorktree, reportPath);
        let r = git(["add", relReport], qaWorktree);
        if (r.status !== 0) {
          const detail = gitErrDetail(r);
          if (detail.includes("did not match any files") || detail.includes("pathspec")) {
            process.stderr.write("INFO: report not in dev-branch working tree; dance already published — skipping helper commit.\n");
          } else {
            throw new Error(detail);
          }
        } else {
          r = git(["commit", "-m", commitMsg], qaWorktree);
          if (r.status !== 0) {
            const detail = gitErrDetail(r);
            if (!detail.includes("nothing to commit")) throw new Error(detail);
          }
        }
      } catch (e) {
        process.stderr.write(`WARNING: failed to commit report: ${e.message}\n`);
        await notify(`Test Handoff Failed: ${feature} — commit error`,
          `Failed to commit test report on qa worktree.\n\nWorktree: ${qaWorktree}\nError: ${e.message}`, "high");
        close(ctx.db);
        return 3;
      }
    } else if (reportOnPublishBranch) {
      process.stderr.write(`INFO: report already on ${publishBranch}; dance owns the commit.\n`);
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
    const publishBranch = getFlag("--publish-branch", flags) || "";
    const forceApprove  = flags.includes("--force-approve");
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

    // Phase 3b: report may live only on the publish side-branch after the dance.
    const reviewWorktreeProbe = featureWorktreePath({ project: ctx.project, projectRoot: ctx.projectRoot, feature });
    const reviewReportOnPublishBranch = !existsSync(reportPath)
      && publishBranch
      && existsSync(reviewWorktreeProbe)
      && git(["cat-file", "-e", `${publishBranch}:${relative(reviewWorktreeProbe, reportPath).replaceAll("\\","/")}`], reviewWorktreeProbe).status === 0;
    if (!forceApprove && !existsSync(reportPath) && !reviewReportOnPublishBranch) {
      close(ctx.db);
      process.stderr.write(`ERROR: report not found at ${reportPath}\n`);
      await notify(`Review Failed: ${feature} — report missing`,
        `Report file not found at ${reportPath} (and not on publish branch ${publishBranch || "<unset>"})\n\nCheck the path and re-run.`, "high");
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

    // Commit report on code-review worktree (skip when the dance already did).
    // Phase 3b: all session kinds share the single feature worktree. When the
    // review-session dance has already published the report on the side-branch,
    // the dev-branch working tree no longer has the file — the helper just
    // records the verdict + advances the row.
    const worktree = reviewWorktreeProbe;
    if (existsSync(worktree) && !reviewReportOnPublishBranch) {
      const commitMsg = `[${correlationId}] Review report: ${feature} — ${verdict}`;
      try {
        const relReport = relative(worktree, reportPath);
        let r = git(["add", relReport], worktree);
        if (r.status !== 0) {
          const detail = gitErrDetail(r);
          if (detail.includes("did not match any files") || detail.includes("pathspec")) {
            process.stderr.write("INFO: report not in dev-branch working tree; dance already published — skipping helper commit.\n");
          } else {
            throw new Error(detail);
          }
        } else {
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
        }
      } catch (e) {
        process.stderr.write(`WARNING: failed to commit report: ${e.message}\n`);
        await notify(`Review Failed: ${feature} — commit error`,
          `Failed to commit report on code-review worktree.\n\nWorktree: ${worktree}\nError: ${e.message}`, "high");
        close(ctx.db);
        return 3;
      }
    } else if (reviewReportOnPublishBranch) {
      process.stderr.write(`INFO: report already on ${publishBranch}; dance owns the commit.\n`);
    } else {
      process.stderr.write(`WARNING: code-review worktree not found at ${worktree}; skipping commit\n`);
    }

    // Branch on verdict
    try {
      if (verdict === "ready_to_ship" || forceApprove) {
        const ts = new Date().toISOString().replace(/\.\d+Z$/, "Z");
        const updateFields = { stage: "merge", review_verdict: "ready_to_ship", review_retries: 0, qa_pass: 1 };
        if (forceApprove) {
          // Re-read notes_extra immediately before writing to minimise the
          // window between read and write (async git ops above could race).
          const fresh = rowGet(ctx.db, ctx.project, feature);
          const existing = ((fresh || row).notes_extra || "").trim();
          updateFields.notes_extra = existing ? `${existing} [operator-override ${ts}]` : `[operator-override ${ts}]`;
        }
        const ok = rowUpdate(ctx.db, ctx.project, feature, updateFields);
        if (!ok) {
          process.stderr.write(`ERROR: stage-set failed\n`);
          await notify(`Review Failed: ${feature} — stage-set error`,
            `Failed to advance to merge stage.`, "high");
          return 6;
        }
        if (forceApprove) {
          process.stderr.write(`INFO: force-approve bypassed report check and advanced to merge\n`);
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
        // Stale-raise detection: if every concern in this report fingerprint-matches
        // the previous report, warn the operator before burning another dev cycle.
        if (reviewRetries >= 1 && publishBranch) {
          const staleness = await detectStaleRaise(reportPath, reviewWorktreeProbe, publishBranch, reviewRetries, feature);
          if (staleness === "all_stale") {
            await notify(
              `Review Warning: ${feature} — possible stale re-raise (retry ${reviewRetries + 1}/${reviewRetryBudget})`,
              `All concerns in retry${reviewRetries + 1} fingerprint-match retry${reviewRetries}. ` +
              `Check the report before the next dev cycle starts.`,
              "low"
            );
          }
        }
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
      // Prefer the row's plan_file column (set by queue-plan with no shell
      // hop) over the argv plan-file -- the latter can arrive shell-escaped
      // when the dev session's hand-off command spelt the path with
      // backslashes (e.g. `C:\code\...`), which collapses to `C:code...` and
      // strips every separator. Fall back to argv only when the row is
      // missing the column.
      const planFileTrusted = devCompleteRow?.plan_file || planFile;
      const reclaimed = reclaimPlanIfMisplaced(planFileTrusted);
      if (reclaimed.moved) {
        process.stderr.write(`[reclaim] restored ${basename(planFileTrusted)} from complete/\n`);
        await notify("Plan File Restored",
          `${feature}: plan file was prematurely moved to complete/; restored before review handoff.`,
          "low");
      }
      const cwd = featureWorktreePath({
        project: ctx.project, projectRoot: ctx.projectRoot, feature,
      });
      sessionPath = generateSessionFile(ctx.project, planFileTrusted, "review", {
        projectRoot: ctx.projectRoot,
        feature,
        reviewRetries: devCompleteRow?.review_retries ?? 0,
        branch: resolveRowBranch(devCompleteRow, feature),
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

  // ── plans-list ────────────────────────────────────────────────────────────────
  if (cmd === "plans-list") {
    const [projectArg, ...flags] = argv;
    let project = projectArg;
    const statusFilter = getFlag("--status", flags);

    const { listEnabledProjects } = await import("../../scripts/pipeline-db/projects.mjs");
    const { plansList } = await import("../../scripts/pipeline-db/index.mjs");
    const { connectUnified, close: closeDb } = await import("../../scripts/pipeline-db/index.mjs");

    try {
      const db = connectUnified();
      try {
        // If no project specified, list all projects
        const projects = project ? [project] : listEnabledProjects(db);
        for (const proj of projects) {
          const plans = plansList(db, { project: proj, status: statusFilter || undefined });
          for (const plan of plans) {
            process.stdout.write(`${plan.project}\t${plan.slug}\t${plan.title || ''}\t${plan.status}\n`);
          }
        }
      } finally { closeDb(db); }
      return 0;
    } catch (e) {
      process.stderr.write(`ERROR: ${e.message}\n`);
      return 1;
    }
  }

  // ── plans-search ──────────────────────────────────────────────────────────────
  if (cmd === "plans-search") {
    const [query] = argv;
    if (!query) {
      process.stderr.write("usage: plans-search <query>\n");
      return 1;
    }

    const { plansSearch } = await import("../../scripts/pipeline-db/index.mjs");
    const { connectUnified, close: closeDb } = await import("../../scripts/pipeline-db/index.mjs");

    try {
      const db = connectUnified();
      try {
        const results = plansSearch(db, query);
        for (const result of results) {
          process.stdout.write(`${result.project}\t${result.slug}\t${result.title || ''}\t${result.status}\n`);
        }
      } finally { closeDb(db); }
      return 0;
    } catch (e) {
      process.stderr.write(`ERROR: ${e.message}\n`);
      return 1;
    }
  }

  return null;
}
