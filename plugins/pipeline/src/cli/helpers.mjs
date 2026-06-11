import { spawnSync } from "node:child_process";

export function getFlag(name, argv) {
  const i = argv.indexOf(name);
  return i !== -1 && i + 1 < argv.length ? argv[i + 1] : null;
}

export const DEFAULT_TARGET_BRANCH_FALLBACK = "main";

// Detect the repo's default branch for the given working directory.
// Order: remote HEAD → git config init.defaultBranch → DEFAULT_TARGET_BRANCH_FALLBACK.
export function detectDefaultBranch(cwd) {
  const rHead = spawnSync("git", ["symbolic-ref", "refs/remotes/origin/HEAD"],
    { cwd, stdio: ["ignore", "pipe", "pipe"] });
  if (rHead.status === 0) {
    const m = rHead.stdout.toString().trim().match(/refs\/remotes\/origin\/(.+)/);
    if (m) return m[1];
  }
  const rCfg = spawnSync("git", ["config", "init.defaultBranch"],
    { cwd, stdio: ["ignore", "pipe", "pipe"] });
  if (rCfg.status === 0) {
    const b = rCfg.stdout.toString().trim();
    if (b) return b;
  }
  return DEFAULT_TARGET_BRANCH_FALLBACK;
}

export function formatRow(r) {
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
    pr_title:            r.pr_title || null,
    depends_on:          r.depends_on || null,
    waits_on:            r.waits_on || null,
    base_branch:         r.base_branch || null,
  };
}
