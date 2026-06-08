export const PIPELINE_DEFAULTS = {
  models: {
    dev_default:    "claude-haiku-4-5",
    review_default: "claude-sonnet-4-6",
    governor:       "claude-sonnet-4-6",
    doc_impact:     "claude-haiku-4-5",
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
    // Forwarder hook: shell command that receives the envelope JSON path as
    // its only argv. Setup wizard wires this to the bundled claude-slack
    // forwarder when a Slack channel is configured and claude-slack is on
    // PATH. Users can replace with any executable (different notifier,
    // custom routing, etc) — see README "Notifications" section.
    on_write:         null,
    fallback_dir:     null,
  },
  review: { skill: "/code-review", deep_flag: "" },
  plansDir: "plans",
  session_templates_dir: null,
  merge: {
    doc_impact_enabled: false,
    commit_extras:      [],
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
