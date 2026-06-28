import { execSync, spawnSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { rowsList } from "../../db/rows.mjs";
import { projectList } from "../../db/projects.mjs";

// Detect zombie rows: stage=done but plan_file is not under plans/complete/
export function findZombieRows(db, project, projectRoot, { apply = false } = {}) {
  const rows = rowsList(db, project, { excludeStages: [] }) || [];
  const findings = [];

  const plansDir = join(projectRoot, "plans");
  const completePlansDir = join(plansDir, "complete");

  for (const row of rows) {
    if (row.stage !== "done") continue;

    // Check if plan_file is under plans/complete/ by checking path segments
    const planFileNorm = row.plan_file ? row.plan_file.split("\\").join("/") : "";
    const planFileUnderComplete = planFileNorm.includes("plans/complete/");

    if (!planFileUnderComplete) {
      // Check if a commit on target_branch references the feature slug
      let needsMoveAction = false;
      let commitRefersToSlug = false;

      try {
        // Search for commits on target branch that mention the feature slug
        const targetBranch = row.target_branch || "main";
        const result = spawnSync("git", [
          "-C", projectRoot,
          "log", targetBranch,
          "--all",
          "--oneline",
          `--grep=${row.feature}`,
        ], { encoding: "utf8", windowsHide: true });

        if (result.status === 0 && result.stdout && result.stdout.trim()) {
          // Found a commit referencing the slug
          commitRefersToSlug = true;
          needsMoveAction = apply;
        } else {
          needsMoveAction = false;
        }
      } catch (e) {
        needsMoveAction = false;
      }

      findings.push({
        type: "zombie-done-row",
        severity: "warn",
        project,
        feature: row.feature,
        stage: row.stage,
        planFile: row.plan_file,
        commitRefersToSlug,
        needsMoveAction,
        targetBranch: row.target_branch || "main",
      });
    }
  }

  return findings;
}

// Detect orphan autonomous branches: ref exists, no row references it, zero commits beyond merge-base
export function findOrphanBranches(db, projectRoot, { apply = false } = {}) {
  const findings = [];

  if (!existsSync(projectRoot)) return findings;

  try {
    // List all autonomous branches in this repo
    const result = spawnSync("git", [
      "-C", projectRoot,
      "branch", "-a",
      "--format=%(refname:short)",
    ], { encoding: "utf8", windowsHide: true });

    if (result.status !== 0) return findings;

    const allBranches = result.stdout.split(/\r?\n/).filter(Boolean);
    const autonomousBranches = allBranches.filter(b => b.startsWith("autonomous/") || b.startsWith("remotes/origin/autonomous/"));

    for (const branchRef of autonomousBranches) {
      const branch = branchRef.replace(/^remotes\/origin\//, "");
      const slug = branch.replace(/^autonomous\//, "");

      // Check if any row references this slug
      const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all();
      let rowExists = false;

      if (tables.some(t => t.name === "pipeline_rows")) {
        const rows = db.prepare("SELECT * FROM pipeline_rows WHERE feature = ?").all(slug);
        rowExists = rows && rows.length > 0;
      }

      if (!rowExists) {
        // Check if the branch has zero commits beyond merge-base with main
        let commitsAhead = 0;
        let targetBranch = "main";

        try {
          const aheadResult = spawnSync("git", [
            "-C", projectRoot,
            "rev-list", `${targetBranch}..${branch}`, "--count",
          ], { encoding: "utf8", windowsHide: true });

          if (aheadResult.status === 0) {
            commitsAhead = parseInt(aheadResult.stdout.trim(), 10) || 0;
          }
        } catch (e) {
          // Continue with conservative estimate
        }

        if (commitsAhead === 0) {
          findings.push({
            type: "orphan-autonomous-branch",
            severity: "warn",
            branch,
            slug,
            commitsAhead,
            branchRef,
          });
        }
      }
    }
  } catch (e) {
    // Non-fatal
  }

  return findings;
}

// Detect merge-ready stuck: stage=merge, [merge-ready-fired] in notes, >24h old, no commit on target referencing slug
export function findMergeReadyStuck(db, project, projectRoot, { hoursThreshold = 24 } = {}) {
  const findings = [];
  const rows = rowsList(db, project, { excludeStages: [] }) || [];

  for (const row of rows) {
    if (row.stage !== "merge") continue;

    // Check if notes_extra contains [merge-ready-fired]
    const hasFireTag = row.notes_extra && row.notes_extra.includes("[merge-ready-fired]");
    if (!hasFireTag) continue;

    // Check age: >24h old
    const createdAt = row.created_at ? new Date(row.created_at) : null;
    const now = new Date();
    const ageMs = createdAt ? now - createdAt : 0;
    const ageHours = ageMs / (1000 * 60 * 60);

    if (ageHours < hoursThreshold) continue;

    // Check if a commit on target_branch references the slug
    let commitRefersToSlug = false;

    try {
      const targetBranch = row.target_branch || "main";
      const result = spawnSync("git", [
        "-C", projectRoot,
        "log", targetBranch,
        "--all",
        "--oneline",
        `--grep=${row.feature}`,
      ], { encoding: "utf8", windowsHide: true });

      if (result.status === 0 && result.stdout && result.stdout.trim()) {
        commitRefersToSlug = true;
      }
    } catch (e) {
      // Non-fatal
    }

    if (!commitRefersToSlug) {
      findings.push({
        type: "merge-ready-stuck",
        severity: "warn",
        project,
        feature: row.feature,
        stage: row.stage,
        ageHours: Math.round(ageHours),
        targetBranch: row.target_branch || "main",
        createdAt,
      });
    }
  }

  return findings;
}

// Main entry point for the zombie-rows check
export async function checkZombieRows({ db, paths, apply = false } = {}) {
  if (!db) throw new Error("checkZombieRows: db is required");
  if (!paths) throw new Error("checkZombieRows: paths is required");

  const allFindings = [];

  try {
    // Load projects from DB
    const projects = projectList(db) || [];

    for (const project of projects) {
      if (!existsSync(project.root_path)) continue;

      // Check zombie rows for this project
      const zombieRows = findZombieRows(db, project.name, project.root_path, { apply });
      allFindings.push(...zombieRows);

      // Check merge-ready stuck for this project
      const mergeStuck = findMergeReadyStuck(db, project.name, project.root_path);
      allFindings.push(...mergeStuck);
    }

    // Check orphan branches across all projects
    for (const project of projects) {
      if (!existsSync(project.root_path)) continue;
      const orphans = findOrphanBranches(db, project.root_path, { apply });
      allFindings.push(...orphans);
    }
  } catch (e) {
    // Errors in this check are non-fatal
  }

  return allFindings;
}

// Format findings for display
export function formatZombieRowsFindings(findings) {
  if (!findings || findings.length === 0) {
    return "✓ no zombie rows, orphan branches, or stuck merge-ready rows found";
  }

  const lines = [];
  const zombies = findings.filter(f => f.type === "zombie-done-row");
  const orphans = findings.filter(f => f.type === "orphan-autonomous-branch");
  const stuck = findings.filter(f => f.type === "merge-ready-stuck");

  if (zombies.length > 0) {
    lines.push(`⚠ ${zombies.length} zombie done-row(s):`);
    for (const z of zombies) {
      lines.push(`  • ${z.project}/${z.feature}: plan_file=${z.planFile}`);
      if (z.commitRefersToSlug) {
        lines.push(`    → Commit found on target (${z.targetBranch}) — run \`pipeline doctor --apply\` to move plan to complete/`);
      } else {
        lines.push(`    → No commit on target (${z.targetBranch}) — operator intervention needed`);
      }
    }
  }

  if (orphans.length > 0) {
    lines.push(`⚠ ${orphans.length} orphan autonomous branch(es):`);
    for (const o of orphans) {
      lines.push(`  • ${o.branch} (slug=${o.slug}): ${o.commitsAhead} commits ahead of main`);
      if (o.commitsAhead === 0) {
        lines.push(`    → Run: git branch -D ${o.branch} && git push origin --delete ${o.slug}`);
      }
    }
  }

  if (stuck.length > 0) {
    lines.push(`⚠ ${stuck.length} merge-ready stuck row(s):`);
    for (const s of stuck) {
      lines.push(`  • ${s.project}/${s.feature}: stuck for ${s.ageHours}h`);
      lines.push(`    → Check status manually; no auto-remediation for merge-ready stuck`);
    }
  }

  return lines.join("\n");
}
