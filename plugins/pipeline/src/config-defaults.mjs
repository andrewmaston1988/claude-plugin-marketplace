export const PIPELINE_DEFAULTS = {
  models: {
    dev_default:    "claude-haiku-4-5",
    review_default: "claude-sonnet-4-6",
    governor:       "claude-sonnet-4-6",
  },
  notifications: {
    // Governance / reports channel — where Cache Health, monthly governance,
    // ad-hoc reports go. Distinct from pipeline_channel so report content
    // can stay in a curated channel without spamming orchestrator pings.
    // Backward-compat: a legacy `slack_channel` key is still read by the
    // forwarder/doctor when `governance_channel` is unset, so existing
    // configs continue to work for one release.
    governance_channel: null,
    // Pipeline-event channel — orchestrator events (spawn, park, dev-complete,
    // review-pass, etc). Falls back to governance_channel when null.
    pipeline_channel:   null,
    // Legacy: on_write fallback for one release (see hooks.on_notification).
    on_write:         null,
    fallback_dir:     null,
  },
  hooks: {
    // Array of { command: "..." } objects — Claude Code hook shape.
    // on_notification: fired on every published notification/report.
    //   argv[1]: path to JSON envelope file (schema_version, kind, title, body)
    // on_merge_ready: fired when a row reaches stage=merge.
    //   env: PIPELINE_PROJECT, PIPELINE_FEATURE, PIPELINE_BRANCH, PIPELINE_TARGET_BRANCH
    on_notification: null,   // null | string (legacy) | [{command}]
    on_merge_ready:  null,   // null | string | [{command}]
  },
  autoMerge:  false,
  review:     { skill: "/code-review", deep_flag: "" },
  plansDir:   "plans",
  // Branch-name prefixes recognised as orchestration branches. Used by the
  // queue lint to warn (not error) when --target-branch carries an unfamiliar
  // prefix. Defaults cover orchestrator-spawned and operator-driven sessions.
  recognised_branch_types: ["autonomous", "interactive"],
  session_templates_dir: null,
  // Single worktree per feature. The orchestrator creates this on first spawn;
  // review/test sessions create it if missing. Phase 3b default.
  worktree_base: "{root_parent}/.worktrees/{project}/{feature}",
  // Per-kind reports dir under the single feature worktree. Placeholders: {project}, {feature}.
  report_subpath: {
    "code-review": "reports",
    "qa-test":     "test-reports",
  },
  // Side-branch the stash-switchback dance publishes reports to. Placeholders: {kind}, {feature}.
  report_publish_branch_template: "{kind}/{feature}",
  governor: {
    enabled:       false,
    project:       null,
    template_path: null,
    reports_dir:   null,
    session_dir:   null,
    log_dir:       null,
  },
};
