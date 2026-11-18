// The one place "how to test plugin X" is written. The test-runner CLI reads it
// and scripts/test-config.test.mjs imports it, so CI and a local run execute the
// same commands by construction.

const TEN_MIN = 10 * 60 * 1000;
const TWENTY_MIN = 20 * 60 * 1000;

export default {
  base: ["origin/master", "master"],
  // The config file and the root lockfile always select everything by rule.
  selectAll: [".github/workflows/test.yml", "scripts/test.mjs"],
  repoSuite: "repo",
  packages: ["plugins/*"],
  fallback: [
    "**/package.json",
    "**/package-lock.json",
    "**/.env.test",
    "**/hooks/hooks.json",
    "**/.claude-plugin/**",
    "**/.codex-plugin/**",
  ],
  skipDirs: ["sessions"],
  suites: [
    {
      name: "checkpoint",
      runs: [
        {
          cwd: ".",
          globs: ["plugins/checkpoint/hooks/tests/*.test.mjs"],
          timeoutMs: TEN_MIN,
        },
      ],
    },
    {
      name: "slack-bridge",
      runs: [
        {
          cwd: ".",
          globs: [
            "plugins/slack-bridge/tests/*.test.mjs",
            "plugins/slack-bridge/tests/*/*.test.mjs",
          ],
          timeoutMs: TEN_MIN,
        },
      ],
    },
    {
      name: "claude-peers",
      runs: [
        {
          cwd: ".",
          globs: ["plugins/claude-peers/tests/*.test.mjs"],
          timeoutMs: TEN_MIN,
        },
      ],
    },
    {
      name: "swarm",
      // `**` matches every test file at any depth below `tests/`.
      runs: [
        {
          cwd: "plugins/swarm",
          globs: ["tests/**/*.test.mjs"],
          timeoutMs: TWENTY_MIN,
        },
      ],
    },
    {
      name: "ui-probe",
      runs: [
        {
          label: "browser",
          cwd: ".",
          globs: ["plugins/ui-probe/tests/*.test.mjs"],
          env: { UI_PROBE_REQUIRE_BROWSER: "1" },
          timeoutMs: TEN_MIN,
        },
        {
          // The bakeoff protocol smoke test is offline: every egress point is a
          // fake injected at call time, so it needs neither a browser nor the
          // plugin's env.
          label: "bakeoff",
          cwd: ".",
          globs: ["bakeoff/ui-probe/protocols/tests/*.test.mjs"],
          timeoutMs: TEN_MIN,
        },
      ],
    },
    {
      name: "pipeline",
      runs: [
        {
          label: "core",
          cwd: "plugins/pipeline",
          globs: ["tests/*.mjs"],
          exclude: ["parity-runner"],
          envFile: ".env.test",
          install: ["npm", "ci"],
          timeoutMs: TEN_MIN,
        },
        {
          label: "parity",
          cwd: "plugins/pipeline",
          globs: ["tests/parity-runner.mjs"],
          envFile: ".env.test",
          install: ["npm", "ci"],
          timeoutMs: TEN_MIN,
        },
        {
          label: "script",
          cwd: "plugins/pipeline",
          globs: [
            "src/hooks/*.test.mjs",
            "src/db/*.test.mjs",
            "skills/merge/scripts/*.test.mjs",
          ],
          install: ["npm", "ci"],
          timeoutMs: TEN_MIN,
        },
      ],
    },
    {
      name: "agent-investigation",
      runs: [
        {
          cwd: ".",
          globs: ["plugins/agent-investigation/tests/*.test.mjs"],
          timeoutMs: TEN_MIN,
        },
      ],
    },
    {
      name: "discipline",
      runs: [
        {
          cwd: ".",
          globs: ["plugins/discipline/hooks/tests/*.test.mjs"],
          timeoutMs: TEN_MIN,
        },
      ],
    },
    {
      name: "repo",
      runs: [
        {
          cwd: ".",
          globs: ["scripts/*.test.mjs"],
          timeoutMs: TEN_MIN,
        },
      ],
    },
  ],
  // Tests no suite runs, each with the reason it is left out. A deliberately
  // unrun test is a recorded decision; anything else the orphan check reports
  // is an accident. Empty today: the bakeoff smoke test runs offline, so
  // ui-probe registers it rather than exempting it.
  notRun: [],
  wsl: {
    distro: "ubuntu",
    setup: "TESTING.md, section \"The ubuntu distro\", has the one-time distro setup.",
    requires: ["git", "rsync", "node", "npm"],
  },
};
