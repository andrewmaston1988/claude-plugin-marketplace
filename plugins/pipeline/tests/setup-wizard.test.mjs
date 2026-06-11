// Wizard worktree-layout step (Step 7/11) — non-interactive paths only.
//
// One runWizard run per test. The step-labels test that captures stdout
// MUST run first: overriding process.stdout.write mid-suite swallows the
// subsequent test's "test:pass" reporter event on Windows and silently
// drops it from the TAP output.
import { test } from "node:test";
import { equal, deepEqual, ok, match } from "node:assert/strict";
import {
  mkdtempSync, rmSync, readFileSync, mkdirSync, writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runWizard } from "../src/setup/wizard.mjs";
import { PIPELINE_DEFAULTS } from "../src/config-defaults.mjs";

function freshPaths() {
  const tmp = mkdtempSync(join(tmpdir(), "pipeline-wizard-"));
  const projectRoot = join(tmp, "code", "demo-app");
  mkdirSync(projectRoot, { recursive: true });
  // gitdir-pointer .git file is enough for projectAdd's loose git-ness check.
  writeFileSync(join(projectRoot, ".git"), "gitdir: ./not-a-real-repo\n");
  return {
    tmp,
    projectRoot,
    paths: {
      configDir: join(tmp, "pipeline"),
      stateDir:  join(tmp, "state"),
      dataDir:   join(tmp, "data"),
      logDir:    join(tmp, "logs"),
    },
  };
}

function cleanup(tmp) { rmSync(tmp, { recursive: true, force: true }); }

const baseOpts = {
  nonInteractive: true,
  installDeps:    false,
  installAutostart: false,
  installPathAlias: false,
  continueOnFailedPrechecks: true,
};

// Step labels test MUST come first — see comment at top of file.
test("wizard: step labels renumbered to /11 (no stale /10 strings emitted)", async () => {
  const ctx = freshPaths();
  const captured = [];
  const origWrite = process.stdout.write.bind(process.stdout);
  process.stdout.write = (s) => { captured.push(String(s)); return true; };
  try {
    await runWizard({ paths: ctx.paths, log: () => {}, opts: baseOpts });
  } finally {
    process.stdout.write = origWrite;
    cleanup(ctx.tmp);
  }
  const out = captured.join("");
  match(out, /Step 1\/11 — Environment check/);
  match(out, /Step 5\/11 — Web dashboard port/);
  match(out, /Step 6\/11 — Register first project/);
  match(out, /Step 7\/11 — Worktree layout/);
  match(out, /Step 8\/11 — Autostart/);
  match(out, /Step 11\/11 — Done/);
  ok(!/Step \d+\/10 /.test(out), "no /10 step labels should remain");
});

test("wizard: choice 1 (default) writes phase-3b worktree keys", async () => {
  const ctx = freshPaths();
  await runWizard({
    paths: ctx.paths,
    log: () => {},
    opts: {
      ...baseOpts,
      registerProjects: [{ name: "demo", rootPath: ctx.projectRoot }],
    },
  });
  const cfg = JSON.parse(readFileSync(join(ctx.paths.configDir, "config.json"), "utf8"));
  equal(cfg.worktree_base, PIPELINE_DEFAULTS.worktree_base);
  deepEqual(cfg.report_subpath, PIPELINE_DEFAULTS.report_subpath);
  equal(cfg.report_publish_branch_template, PIPELINE_DEFAULTS.report_publish_branch_template);
  cleanup(ctx.tmp);
});

// Choice-2 path: custom template — `--worktree-layout 2 --worktree-base <tpl>`.
// Unknown placeholders warn but are accepted (rendered literally at use time).
test("wizard: --worktree-layout 2 writes custom template; unknown placeholders pass through", async () => {
  const ctx = freshPaths();
  const typo = "{root_parent}/.worktrees/{projetc}/{feature}";
  await runWizard({
    paths: ctx.paths,
    log: () => {},
    opts: {
      ...baseOpts,
      registerProjects: [{ name: "demo", rootPath: ctx.projectRoot }],
      worktreeLayout: "2",
      worktreeBase: typo,
    },
  });
  const cfg = JSON.parse(readFileSync(join(ctx.paths.configDir, "config.json"), "utf8"));
  equal(cfg.worktree_base, typo);
  deepEqual(cfg.report_subpath, PIPELINE_DEFAULTS.report_subpath);
  equal(cfg.report_publish_branch_template, PIPELINE_DEFAULTS.report_publish_branch_template);
  cleanup(ctx.tmp);
});
