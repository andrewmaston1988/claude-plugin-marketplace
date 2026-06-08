import { existsSync } from "node:fs";
import { join } from "node:path";
import { close, rowGet, rowsList, rowUpdate } from "../../scripts/pipeline-db/index.mjs";
import { getFlag } from "./helpers.mjs";
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

function buildStageSetFields(newStage, opts = {}) {
  const { notes, qaPass, branch, rModel, dModel, qModel, rvwModel,
          reviewVerdict, reviewRetries, dependsOn, rebaseRequired, targetBranch } = opts;
  const fields = { stage: newStage };
  if (branch !== null && branch !== undefined && branch !== "—") fields.branch = branch;
  if (qaPass !== null && qaPass !== undefined) {
    fields.qa_pass = qaPass === "true" ? 1 : (qaPass === "false" ? 0 : null);
  }
  if (notes !== null && notes !== undefined) fields.notes_extra = notes;
  for (const [col, val] of [["r_model", rModel], ["d_model", dModel],
                             ["q_model", qModel], ["rvw_model", rvwModel]]) {
    if (val !== null && val !== undefined) fields[col] = val === "—" ? null : val;
  }
  if (dependsOn !== null && dependsOn !== undefined) {
    fields.depends_on = dependsOn.trim() || null;
  }
  if (rebaseRequired !== null && rebaseRequired !== undefined) {
    fields.rebase_required = rebaseRequired ? 1 : 0;
  }
  if (targetBranch !== null && targetBranch !== undefined) fields.target_branch = targetBranch;
  if (reviewVerdict !== null && reviewVerdict !== undefined) {
    fields.review_verdict = reviewVerdict === "—" ? null : reviewVerdict;
  }
  if (reviewRetries !== null && reviewRetries !== undefined) {
    fields.review_retries = parseInt(String(reviewRetries), 10);
  }
  return fields;
}

export async function run(cmd, argv) {

  if (cmd === "stage-set") {
    const [project, feature, newStage, ...flags] = argv;
    if (!project || !feature || !newStage) {
      process.stderr.write("usage: stage-set <project> <feature> <new-stage>\n");
      return 1;
    }
    const qaPass = getFlag("--qa-pass", flags);
    if (["merge", "manual"].includes(newStage) && qaPass === null) {
      process.stderr.write(
        "error: --qa-pass true|false is required when advancing to merge or manual\n"
      );
      return 1;
    }
    const effectiveQaPass = (qaPass === null && newStage === "queued") ? "—" : qaPass;

    const ctx = lookupProjectOrFail(project);
    if (!ctx) return 1;
    try {
      const fields = buildStageSetFields(newStage, {
        notes:          getFlag("--notes", flags),
        qaPass:         effectiveQaPass,
        branch:         getFlag("--branch", flags),
        rModel:         getFlag("--r-model", flags),
        dModel:         getFlag("--d-model", flags),
        qModel:         getFlag("--q-model", flags),
        rvwModel:       getFlag("--rvw-model", flags),
        reviewVerdict:  getFlag("--review-verdict", flags),
        reviewRetries:  getFlag("--review-retries", flags),
        dependsOn:      getFlag("--depends", flags),
        rebaseRequired: getFlag("--rebase-required", flags) !== null
                          ? parseInt(getFlag("--rebase-required", flags), 10)
                          : null,
        targetBranch:   getFlag("--target-branch", flags),
      });
      const ok = rowUpdate(ctx.db, ctx.project, feature, fields);
      if (ok) { process.stdout.write("OK\n"); return 0; }
      process.stderr.write(`not found: feature '${feature}'\n`);
      return 1;
    } finally { close(ctx.db); }
  }

  if (cmd === "stage-get") {
    const [project, feature] = argv;
    if (!project || !feature) {
      process.stderr.write("usage: stage-get <project> <feature>\n");
      return 1;
    }
    const ctx = lookupProjectOrFail(project);
    if (!ctx) return 1;
    try {
      const row = rowGet(ctx.db, ctx.project, feature);
      if (!row) { process.stderr.write(`not found: feature '${feature}'\n`); return 1; }
      process.stdout.write(`stage=${row.stage}\n`);
      return 0;
    } finally { close(ctx.db); }
  }

  if (cmd === "done") {
    const [project, feature] = argv;
    if (!project || !feature) {
      process.stderr.write("usage: done <project> <feature>\n");
      return 1;
    }
    const ctx = lookupProjectOrFail(project);
    if (!ctx) return 1;
    try {
      const row = rowGet(ctx.db, ctx.project, feature);
      if (!row) { process.stderr.write(`not found: feature '${feature}'\n`); return 1; }
      if (row.stage !== "manual") {
        process.stderr.write(`stage is '${row.stage}', not 'manual' — cannot advance\n`);
        return 1;
      }
      const fields = { stage: "merge" };
      const qaVal = row.qa_pass;
      if (qaVal === 1) fields.qa_pass = 1;
      else if (qaVal === 0) fields.qa_pass = 0;
      const rv = row.review_verdict;
      if (rv === "ready_to_ship" || rv === "needs_work") fields.review_verdict = rv;
      if (fields.qa_pass === undefined && fields.review_verdict === undefined) {
        fields.qa_pass = 1;
      }
      rowUpdate(ctx.db, ctx.project, feature, fields);
      const branch = row.branch;
      const hint = branch && branch !== "—"
        ? ` Run /merge ${branch} to complete.`
        : "";
      process.stdout.write(`OK: '${feature}' advanced to merge.${hint}\n`);
      return 0;
    } finally { close(ctx.db); }
  }

  if (cmd === "row-audit") {
    const [project, ...flags] = argv;
    if (!project) {
      process.stderr.write("usage: row-audit <project> [--verbose]\n");
      return 1;
    }
    const verbose = flags.includes("--verbose");
    const ctx = lookupProjectOrFail(project);
    if (!ctx) return 1;
    try {
      const rows = rowsList(ctx.db, ctx.project);
      const violations = [];
      for (const r of rows) {
        if (["merge", "manual"].includes(r.stage)) {
          if (r.qa_pass === null || r.qa_pass === undefined) {
            violations.push(r);
            if (verbose) {
              process.stderr.write(`VIOLATION: ${r.feature} stage=${r.stage}, qa_pass=NULL\n`);
            }
          } else if (verbose) {
            process.stderr.write(`OK: ${r.feature} stage=${r.stage}, qa_pass=${r.qa_pass}\n`);
          }
        } else if (verbose) {
          process.stderr.write(`OK: ${r.feature} stage=${r.stage}, qa_pass=${r.qa_pass}\n`);
        }
      }
      if (violations.length) {
        process.stderr.write(
          `VIOLATION: ${violations.length} row(s) have stage in (merge, manual) with qa_pass=NULL\n`
        );
        for (const r of violations) {
          process.stderr.write(`  ${r.feature}: stage=${r.stage}, qa_pass=NULL\n`);
        }
        return 1;
      }
      process.stdout.write("OK: no invariant violations detected\n");
      return 0;
    } finally { close(ctx.db); }
  }

  if (cmd === "active-progress") {
    const [project, feature] = argv;
    if (!project || !feature) {
      process.stderr.write("usage: active-progress <project> <feature>\n");
      return 1;
    }
    const ctx = lookupProjectOrFail(project);
    if (!ctx) return 1;
    try {
      const row = ctx.db.prepare(
        "SELECT slug FROM progress_files WHERE is_active = 1 AND project = ? AND slug LIKE ? " +
        "ORDER BY created_at DESC LIMIT 1"
      ).get(ctx.project, `%${feature}%`);
      process.stdout.write(`progress=${row ? row.slug : "none"}\n`);
      return 0;
    } finally { close(ctx.db); }
  }

  if (cmd === "next-actions") {
    const [project] = argv;
    if (!project) {
      process.stderr.write("usage: next-actions <project>\n");
      return 1;
    }
    const ctx = lookupProjectOrFail(project);
    if (!ctx) return 1;
    try {
      const rows = rowsList(ctx.db, ctx.project, { excludeStages: ["done"] }).map(formatRow);
      const lines = [];

      for (const r of rows) {
        if (r.stage === "merge") {
          const b = r.branch && r.branch !== "—" ? ` ${r.branch}` : "";
          lines.push(`Next: /merge${b}`);
        }
      }
      for (const r of rows) {
        if (r.stage === "manual") {
          lines.push(
            `Manual steps outstanding — run /pipeline done ${r.feature} after completing.`
          );
        }
      }
      for (const r of rows) {
        if (r.stage === "test") lines.push(`Next: /queue ${r.feature} test`);
      }
      for (const r of rows) {
        if (r.stage === "dev") {
          if (!r.notes.includes("Blocked") && !r.notes.includes("Depends on")) {
            lines.push(`Next: /queue ${r.feature} dev`);
            break;
          }
        }
      }
      for (const r of rows) {
        if (r.stage === "research") { lines.push(`Next: /queue ${r.feature} research`); break; }
      }
      for (const r of rows) {
        if (r.stage === "queued") {
          const m = r.notes.match(/type=(\w+)/);
          const stype = m ? m[1] : "dev";
          lines.push(
            `Queued for auto-${stype}: ${r.feature}. Start the orchestrator.`
          );
        }
      }

      const { readdirSync } = await import("node:fs");
      const plansDir = join(ctx.projectRoot, "plans");
      if (existsSync(plansDir)) {
        const tracked = new Set(rows.map(r => r.feature + ".md"));
        let untracked = 0;
        try {
          for (const f of readdirSync(plansDir)) {
            if (!f.endsWith(".md")) continue;
            if (f.endsWith("-design.md") || f.endsWith("-test-plan.md")) continue;
            if (!tracked.has(f)) untracked++;
          }
        } catch {}
        if (untracked > 0) {
          lines.push(`[backlog] ${untracked} plan(s) not in pipeline — run \`/queue <plan-file>\` to add.`);
        }
      }

      for (const l of lines) process.stdout.write(l + "\n");
      return 0;
    } finally { close(ctx.db); }
  }

  return null;
}
