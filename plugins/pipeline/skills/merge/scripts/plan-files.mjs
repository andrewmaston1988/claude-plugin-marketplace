// Steps 1, 2, 3, 6 — plan file operations.
// Mirrors merge.py: step_1_identify_plans, step_2_verify_done, step_3_update_status,
// step_6_move_plans, step_6b_archive_orphaned_plans, and shared path helpers.
import { existsSync, readFileSync, writeFileSync, mkdirSync, renameSync, readdirSync } from "node:fs";
import { join, basename, relative, dirname } from "node:path";
import { runGit, gitAddWithRetry, gitCommitWithRetry } from "./rebase.mjs";
import { rowGet, rowsList, rowUpdate } from "../../../scripts/pipeline-db/index.mjs";
import { orchestratorWorktreePath } from "../../../scripts/worktree-paths.mjs";

// ── Path helpers ───────────────────────────────────────────────────────────────

export function branchSlug(branch) {
  return branch.startsWith("autonomous/") ? branch.slice("autonomous/".length) : branch;
}

// Worktree the orchestrator created for the autonomous/<slug> branch. Internal
// to the merge layer — public worktree resolution lives in worktree-paths.mjs.
function planWorktree(projectDir, slug) {
  return orchestratorWorktreePath({
    project:     basename(projectDir),
    projectRoot: projectDir,
    branch:      `autonomous/${slug}`,
  });
}

// Per-row plan path lookup. After queue-plan started storing absolute paths,
// the plan's location lives on the row — no need to reconstruct it from a
// `<claudeBase>/repos/<project>/plans/` convention.
export function lookupPlanFile(db, project, slug) {
  if (!db || !project) return null;
  try {
    const row = rowGet(db, project, slug);
    return row?.plan_file ?? null;
  } catch { return null; }
}

// Sessions always live at <projectRoot>/sessions/ (matches Plan #5).
export function sessionsDir(projectRoot) {
  return join(projectRoot, "sessions");
}

// Return the plan file path inside the rebased branch's worktree, or null.
// `plan_file` is the absolute path stored on the row; `slug` is the row key.
export function branchPlanPath(projectDir, slug, planFile) {
  const wt = planWorktree(projectDir, slug);
  if (!existsSync(wt)) return null;
  // Try the same relative location as on the operator's tree.
  const rel = planFile ? relative(dirname(planFile).split("plans")[0] || "/", planFile) : `plans/${slug}.md`;
  const candidate = join(wt, rel);
  if (existsSync(candidate)) return candidate;
  // Fallback: plans/<slug>.md inside the worktree.
  const fallback = join(wt, "plans", `${slug}.md`);
  return existsSync(fallback) ? fallback : null;
}

// ── Regex helpers ──────────────────────────────────────────────────────────────

function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// ── Step 1 — Identify plan files ───────────────────────────────────────────────

// Look each branch's plan_file up from the row. Falls back to scanning the
// directory of the FIRST resolved plan file for unrelated branches that lack
// a registered row (rare — predates pipeline tracking).
export function step1IdentifyPlans(db, project, branches, { plansDir } = {}) {
  const mapping = {};
  let fallbackDir = plansDir ?? null;
  for (const branch of branches) {
    const slug = branchSlug(branch);
    const planFile = lookupPlanFile(db, project, slug);
    if (planFile && existsSync(planFile)) {
      mapping[branch] = planFile;
      if (!fallbackDir) fallbackDir = dirname(planFile);
      process.stdout.write(`[1] ${branch} -> ${planFile}\n`);
      continue;
    }
    if (fallbackDir) {
      const exact = join(fallbackDir, `${slug}.md`);
      if (existsSync(exact)) {
        mapping[branch] = exact;
        process.stdout.write(`[1] ${branch} -> ${exact} (sibling-fallback)\n`);
        continue;
      }
      let hits = [];
      try {
        hits = readdirSync(fallbackDir)
          .filter(f => f.startsWith(slug) && f.endsWith(".md"))
          .sort()
          .map(f => join(fallbackDir, f));
      } catch {}
      if (hits.length) {
        mapping[branch] = hits[0];
        process.stdout.write(`[1] ${branch} -> ${basename(hits[0])} (glob match in sibling dir)\n`);
        continue;
      }
    }
    mapping[branch] = null;
    process.stdout.write(`[1] ${branch} -> no plan file found (no row registered; no sibling fallback)\n`);
  }
  return mapping;
}

// ── Step 2 helpers ─────────────────────────────────────────────────────────────

function normalizePlanPath(claimed, project) {
  let p = claimed.replace(/\\/g, "/").trim();
  if (/^[A-Za-z]:\//.test(p)) {
    const parts = p.split("/");
    const idx = parts.indexOf(project);
    if (idx !== -1) p = parts.slice(idx + 1).join("/");
  }
  return p;
}

function extractPlanFiles(planText) {
  const hm = /^#{1,6}\s*Files Changed\s*$/m.exec(planText);
  if (!hm) return [];

  const sectionStart = hm.index + hm[0].length;
  const ah = /^#{1,6}\s+\S/m.exec(planText.slice(sectionStart));
  const sectionEnd = ah ? sectionStart + ah.index : planText.length;
  const section = planText.slice(sectionStart, sectionEnd);

  const bulletRe = /^\s*[-*]\s+`([^`]+)`\s*(?:\*?\(([^)*]+?)\)\*?)?/mg;
  const out = [];
  let bm;
  while ((bm = bulletRe.exec(section)) !== null) {
    const path = bm[1].trim();
    const verbRaw = (bm[2] || "").trim().toLowerCase();
    let verbLead = (verbRaw.split(/\s+/)[0] || "").replace(/[—–\-,;:]+$/, "");
    out.push([path, verbLead]);
  }
  return out;
}

function verifyPlanFilesInDiff(planText, branch, projectDir, targetBranch, project) {
  const claimed = extractPlanFiles(planText);
  if (!claimed.length) return [];

  const result = runGit(["diff", "--name-only", `${targetBranch}...${branch}`], projectDir, { check: false });
  if (result.code !== 0) {
    return [`${branch}: content-verification: \`git diff\` failed (${result.stderr.trim() || "unknown error"})`];
  }

  const diffFiles = new Set(result.stdout.split("\n").map(l => l.trim()).filter(Boolean));
  const missing = [];

  for (const [path, verb] of claimed) {
    const norm = normalizePlanPath(path, project);
    if (diffFiles.has(norm)) continue;
    if ([...diffFiles].some(df => df.endsWith("/" + norm) || norm.endsWith("/" + df))) continue;
    missing.push(`  - \`${path}\` (claimed: ${verb || "changed"})`);
  }

  if (missing.length) {
    return [
      `${branch}: plan's \`## Files Changed\` lists files NOT in the squash diff ` +
      `(target=${targetBranch}, branch=${branch}):\n` +
      missing.join("\n") +
      "\n  Fix: implement the missing files on the branch, or remove " +
      "them from the plan's Files Changed list if they were dropped.",
    ];
  }
  return [];
}

// ── Step 2 — Verify definition of done ────────────────────────────────────────

export async function step2VerifyDone(db, planFiles, projectDir, project, { skipTesting = false, targetBranch = "main" } = {}) {
  const blockers = [];
  const rows = db ? rowsList(db, project) : [];
  const rowMap = Object.fromEntries(rows.map(r => [r.feature, r]));

  for (const [branch, plan] of Object.entries(planFiles)) {
    const slug = branchSlug(branch);
    const bp = branchPlanPath(projectDir, slug, plan);
    const planToRead = bp || plan;

    if (planToRead && existsSync(planToRead)) {
      const text = readFileSync(planToRead, "utf8");

      const verifyBlockers = verifyPlanFilesInDiff(text, branch, projectDir, targetBranch, project);
      blockers.push(...verifyBlockers);

      const needsTestingRe = /^\s*[-*]\s+.*\(needs testing\)/gim;
      if (needsTestingRe.test(text)) {
        if (skipTesting) {
          const newText = text.replace(/(\(needs testing\))/gi, "(skipped)");
          writeFileSync(planToRead, newText, "utf8");
          const count = (text.match(/^\s*[-*]\s+.*\(needs testing\)/gim) || []).length;
          if (bp && planToRead === bp) {
            const wt = planWorktree(projectDir, slug);
            await gitAddWithRetry(wt, relative(wt, planToRead));
            await gitCommitWithRetry(wt, "-m", `[merge --skip-testing] mark (needs testing) -> (skipped) in ${slug} plan`);
          }
          process.stdout.write(`[2] WARNING: ${branch}: ${count} (needs testing) item(s) marked (skipped) — operator override\n`);
        } else {
          blockers.push(`${branch}: plan has (needs testing) items — finish or mark with explicit note`);
        }
      }
    }

    const row = rowMap[slug];
    if (!row) {
      process.stdout.write(`[2] ${branch}: no pipeline row (predates tracking)\n`);
      continue;
    }

    const stage = (row.stage || "").trim();
    const qaPass = row.qa_pass;

    if (stage === "manual") {
      rowUpdate(db, project, slug, { stage: "merge", qa_pass: qaPass });
      process.stdout.write(`[2] ${branch}: auto-advanced from manual → merge (manual gate override)\n`);
    } else if (stage !== "merge" && stage !== "done") {
      blockers.push(`${branch}: pipeline stage is '${stage}' (expected 'merge')`);
    }

    // qaPass is INTEGER: 0=false, 1=true, null=no verdict.
    if (qaPass === 0) {
      blockers.push(`${branch}: QA Pass is 'false' — fix and re-test before merging`);
    } else if (qaPass == null) {
      blockers.push(`${branch}: QA Pass is '—' — no passing test session`);
    }
  }

  return blockers;
}

// ── Step 3 — Update plan Current Status ───────────────────────────────────────

function locateCurrentStatusBlock(text) {
  const m = /^(#{1,6})\s*Current Status\s*$/m.exec(text);
  if (!m) return null;

  let start = m.index + m[0].length;
  while (start < text.length && text[start] === "\n") start++;

  let end = start;
  while (end < text.length) {
    const lineEnd = text.indexOf("\n", end);
    if (lineEnd < 0) { end = text.length; break; }
    const line = text.slice(end, lineEnd);
    if (line.trim() === "" || line.trimStart().startsWith("#")) break;
    end = lineEnd + 1;
  }
  return [start, end];
}

export function applyPlanStatusEdit(planPath, newStatusLine, oqRemovals = []) {
  let text = readFileSync(planPath, "utf8");
  const block = locateCurrentStatusBlock(text);

  if (block !== null) {
    const [start, end] = block;
    text = text.slice(0, start) + newStatusLine.trimEnd() + "\n" + text.slice(end);
  } else {
    text = text.trimEnd() + `\n\n## Current Status\n\n${newStatusLine.trimEnd()}\n`;
  }

  for (const bullet of oqRemovals) {
    const snippet = bullet.trim();
    if (!snippet) continue;
    const pattern = new RegExp(`^[ \\t]*[-*]\\s*${escapeRegex(snippet)}[^\\n]*\\n`, "gm");
    text = text.replace(pattern, "");
  }

  writeFileSync(planPath, text, "utf8");
}

export async function step3UpdateStatus(planFiles, projectDir, project, { testRefs = {}, mergeDate = null } = {}) {
  const today = mergeDate || new Date().toISOString().slice(0, 10);

  for (const [branch, plan] of Object.entries(planFiles)) {
    if (!plan) continue;
    const slug = branchSlug(branch);
    const bp = branchPlanPath(projectDir, slug, plan);
    const planToEdit = bp || plan;

    process.stdout.write(`[3] Updating Current Status for ${branch}\n`);
    const testRef = testRefs[branch] || "";
    const statusLine = testRef && testRef !== "(no test report)"
      ? `✓ Merged ${today}. Test: ${testRef}.`
      : `✓ Merged ${today}.`;

    applyPlanStatusEdit(planToEdit, statusLine, []);

    if (bp && planToEdit === bp) {
      const wt = planWorktree(projectDir, slug);
      await gitAddWithRetry(wt, relative(wt, planToEdit));
      await gitCommitWithRetry(wt, "-m", `[merge] update ${slug} Current Status post-test`);
    }
  }
}

// ── Step 6 — Move plans to complete/ ──────────────────────────────────────────

export function step6MovePlans(planFiles) {
  for (const [_branch, plan] of Object.entries(planFiles)) {
    if (!plan || !existsSync(plan)) continue;
    const completeDir = join(dirname(plan), "complete");
    mkdirSync(completeDir, { recursive: true });
    const dest = join(completeDir, basename(plan));
    renameSync(plan, dest);
    process.stdout.write(`[5] Moved ${basename(plan)} -> complete/\n`);

    const stem = basename(plan, ".md");
    const testPlan = join(dirname(plan), `${stem}-test-plan.md`);
    if (existsSync(testPlan)) {
      renameSync(testPlan, join(completeDir, basename(testPlan)));
      process.stdout.write(`[5] Moved ${basename(testPlan)} -> complete/\n`);
    }
  }
}

// ── Step 6b — Archive orphaned done plans ──────────────────────────────────────

// Walk distinct plan dirs from done-rows' plan_files. Within each dir, move
// any .md file matching a done-slug into <dir>/complete/ if not already there.
export function step6bArchiveOrphanedPlans(db, project) {
  if (!db || !project) return;
  const rows = rowsList(db, project);
  const doneRows = rows.filter(r => r.stage === "done" && r.plan_file);
  if (!doneRows.length) return;

  const doneSlugs = new Set(doneRows.map(r => r.feature));
  const plansDirs = new Set(doneRows.map(r => dirname(r.plan_file)));

  const archived = [];
  for (const plansDir of plansDirs) {
    if (!existsSync(plansDir)) continue;
    const completeDir = join(plansDir, "complete");
    mkdirSync(completeDir, { recursive: true });

    let entries;
    try { entries = readdirSync(plansDir).filter(f => f.endsWith(".md")); }
    catch { continue; }

    let completed;
    try { completed = new Set(readdirSync(completeDir)); }
    catch { completed = new Set(); }

    for (const file of entries) {
      if (completed.has(file)) continue;
      const slug = file.slice(0, -3);
      if (!doneSlugs.has(slug)) continue;

      const src = join(plansDir, file);
      const dest = join(completeDir, file);
      renameSync(src, dest);
      archived.push(file);

      const testPlan = join(plansDir, `${slug}-test-plan.md`);
      if (existsSync(testPlan)) {
        renameSync(testPlan, join(completeDir, `${slug}-test-plan.md`));
      }
    }
  }

  if (archived.length) {
    const preview = archived.slice(0, 5).join(", ") + (archived.length > 5 ? "..." : "");
    process.stdout.write(`[5b] Archived ${archived.length} orphaned done plans: ${preview}\n`);
  }
}
