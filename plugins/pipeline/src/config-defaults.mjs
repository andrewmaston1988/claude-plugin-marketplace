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
  session_templates_dir: null,
  // Per-kind reports dir under the handler worktree. Placeholders: {project}, {feature}.
  report_subpath: {
    "code-review": "repos/{project}/reports",
    "qa-test":     "repos/{project}/test-reports",
  },
  governor: {
    enabled:       false,
    project:       null,
    template_path: null,
    reports_dir:   null,
    session_dir:   null,
    log_dir:       null,
  },
};
