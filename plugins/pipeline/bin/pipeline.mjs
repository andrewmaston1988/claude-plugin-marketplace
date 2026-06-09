#!/usr/bin/env node
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { run as runDispatch  } from "../src/cli/dispatch.mjs";
import { run as runSession   } from "../src/cli/session.mjs";
import { run as runNotify    } from "../src/cli/notify.mjs";
import { run as runProgress  } from "../src/cli/progress.mjs";
import { run as runStage     } from "../src/cli/stage.mjs";
import { run as runRows      } from "../src/cli/rows.mjs";
import { run as runQueue     } from "../src/cli/queue.mjs";
import { run as runProjects  } from "../src/cli/projects.mjs";
import { getFlag } from "../src/cli/helpers.mjs";

const PLUGIN_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

(async () => {
  const [,, cmd, ...argv] = process.argv;

  if (cmd === "setup") {
    const { runWizard } = await import("../src/setup/wizard.mjs");
    const { getPaths }  = await import("../src/paths.mjs");
    const paths = getPaths();
    const opts = _parseSetupOpts(argv);
    await runWizard({ paths, log: () => {}, opts });
    setTimeout(() => process.exit(0), 150);
    return;
  }

  if (cmd === "doctor") {
    const { runDoctor, printDoctor, doctorExitCode } = await import("../src/setup/doctor.mjs");
    const { getPaths } = await import("../src/paths.mjs");
    const paths = getPaths();
    const timeoutRaw = getFlag("--timeout", argv);
    const timeout = timeoutRaw ? parseInt(timeoutRaw, 10) : 5000;
    const results = await runDoctor({ paths, timeout });
    printDoctor(results);
    setTimeout(() => process.exit(doctorExitCode(results)), 150);
    return;
  }

  if (cmd === "plugin-root") {
    process.stdout.write(PLUGIN_ROOT + "\n");
    setTimeout(() => process.exit(0), 150);
    return;
  }

  if (cmd === "config-get") {
    const key = argv[0];
    if (!key) {
      process.stderr.write("usage: pipeline config-get <key>\n");
      setTimeout(() => process.exit(1), 150);
      return;
    }
    const { loadPipelineConfig } = await import("../src/pipeline-config.mjs");
    const cfg = loadPipelineConfig();
    const val = cfg[key];
    if (val !== undefined && val !== null) process.stdout.write(String(val) + "\n");
    setTimeout(() => process.exit(0), 150);
    return;
  }

  if (cmd === "spawn-merge") {
    const project = argv[0];
    const feature = argv[1];
    if (!project || !feature) {
      process.stderr.write("usage: pipeline spawn-merge <project> <feature>\n");
      setTimeout(() => process.exit(1), 150);
      return;
    }
    const { connectUnified }      = await import("../scripts/pipeline-db/connection.mjs");
    const { listEnabledProjects } = await import("../scripts/pipeline-db/projects.mjs");
    const { rowsList }            = await import("../scripts/pipeline-db/rows.mjs");
    const { spawnMerge, isDirtyTree, isMergedInto } = await import("../scripts/orchestrator/spawn.mjs");

    const db          = connectUnified();
    const projectRoot = new Map(listEnabledProjects(db)).get(project);
    if (!projectRoot) {
      process.stderr.write(`spawn-merge: project '${project}' not registered\n`);
      setTimeout(() => process.exit(1), 150);
      return;
    }
    const rows = rowsList(db, project);
    const row  = rows.find(r => r.feature === feature);
    if (!row) {
      process.stderr.write(`spawn-merge: row '${feature}' not found in project '${project}'\n`);
      setTimeout(() => process.exit(1), 150);
      return;
    }
    if (row.stage !== "merge") {
      process.stderr.write(`spawn-merge: row '${feature}' is at stage '${row.stage}', not 'merge'\n`);
      setTimeout(() => process.exit(1), 150);
      return;
    }
    const branch       = row.branch || `autonomous/${feature}`;
    const targetBranch = row.target_branch || "master";
    const diverged     = !isMergedInto(targetBranch, branch, projectRoot);
    const dirty        = isDirtyTree(projectRoot);
    const model        = (diverged || dirty) ? "claude-sonnet-4-6" : "claude-haiku-4-5";
    spawnMerge(project, row, projectRoot, model, { db: null, dryRun: false, logFn: (m) => process.stderr.write(m + "\n") });
    process.stdout.write(`spawned merge for ${feature} model=${model}\n`);
    setTimeout(() => process.exit(0), 150);
    return;
  }

  if (cmd === "demo") {
    const { run: runDemo } = await import("../src/cli/demo.mjs");
    await runDemo("demo", argv);
    return; // demo handler manages its own lifecycle + signals
  }

  if (cmd === "dashboard") {
    // Dashboard takes over the terminal (blessed for TUI, http server for web).
    // Do NOT run through the dispatch loop's setTimeout(exit) — let the
    // subcommand keep the event loop alive until the user quits / Ctrl-C.
    const subcmd = argv[0];
    if (!subcmd || subcmd === "--help" || subcmd === "-h") {
      process.stderr.write(
        "usage: pipeline dashboard <subcommand>\n" +
        "  tui  [--refresh-ms N]   Launch the TUI dashboard\n" +
        "  web  [--host H] [--port P]   (Phase 4 — not implemented yet)\n"
      );
      setTimeout(() => process.exit(1), 150);
      return;
    }
    if (subcmd === "tui") {
      const refreshMs = parseInt(getFlag("--refresh-ms", argv.slice(1)) || "10000", 10);
      const { runTui } = await import("../src/dashboard/tui/app.mjs");
      runTui({ refreshMs });
      return; // do NOT setTimeout-exit; blessed owns the event loop
    }
    if (subcmd === "web") {
      const host = getFlag("--host", argv.slice(1)) || "127.0.0.1";
      // 8765 sits outside the Windows Hyper-V dynamic exclusion range that
      // typically blocks 5000–5100 with EACCES, and avoids collision-prone 8080.
      const port = parseInt(getFlag("--port", argv.slice(1)) || "8765", 10);
      const { startWebServer } = await import("../src/dashboard/web/server.mjs");
      const { getPaths } = await import("../src/paths.mjs");
      startWebServer({ paths: getPaths(), host, port });
      return; // do NOT setTimeout-exit; server keeps the loop alive
    }
    process.stderr.write(`pipeline dashboard: unknown subcommand '${subcmd}'\n`);
    setTimeout(() => process.exit(1), 150);
    return;
  }

  if (!cmd || cmd === "--help" || cmd === "-h") {
    process.stdout.write(`
pipeline — Pipeline CLI for Claude Code

Usage:
  pipeline <subcommand> [args...]

Setup:
  setup             Run the interactive setup wizard
  doctor            Check environment prerequisites

Watch the pipeline:
  dashboard tui     Launch the TUI dashboard (in-terminal)
  dashboard web     Launch the web dashboard at http://localhost:8765/pipeline

Project registry:
  project-add       <name> <absolute-root-path> [--plans-dir <path>]
  project-list      [--format json|plain]
  project-update    <name> [--plans-dir <path>]
  project-remove    <name> [--purge]
  project-enable    <name>
  project-disable   <name>

Row subcommands (all take <project> = registered project name):
  stage-set         <project> <feature> <new-stage>
  stage-get         <project> <feature>
  row-add           <project> <feature> <plan-file> <stage>
  rows              <project> [--format json|plain|md]
  row-delete        <project> <feature>
  done              <project> <feature>
  next-actions     <project>
  row-audit         <project> [--verbose]
  active-progress   <project> <feature>
  backlog-scan      <project> [<plans-dir>]
  backlog-sync      <project>
  research-complete <project> <research-feature> <dev-feature> <dev-plan>
  test-complete     <project> <feature> --branch-slug <slug> --report <path> ...
  dev-complete      <project> <plan-file> <feature> --title <text> --message <text>
  review-complete   <project> <feature> --report <path> --verdict <v> ...

Progress subcommands (slug is globally unique — <project> arg accepted but only used by progress-create):
  progress-create   <project> <slug> [--steps ...]
  progress-mark     <project> <slug> <step-index> <state>
  progress-get      <project> <slug> [--format md|json|tasks]
  progress-resume   <project> <slug>
  progress-delete   <project> <slug>
  progress-list-active [<project>|--all]
  progress-snippet
  progress-note     <project> <slug> <text>
  progress-set-pid  <project> <slug> <pid>

Queue subcommands:
  queue-name-derive    <brief>
  queue-branch-extract <plan-file>
  queue-deps-extract   <plan-file>
  queue-plan           <project> <plan-file>
  queue-mode-detect    <plans-dir> <arguments>

Other:
  spawn-merge          <project> <feature>
  session-generate     <project> <plan-file> <session-type>
  notify               --title <text> --message <text>
  target-branch-get    <project> <feature>
  rebase-required-set  <project> <feature> <0|1>
  plugin-root          Print the absolute path to this plugin's root directory
  config-get <key>     Print a single config value (empty output if unset)
`);
    setTimeout(() => process.exit(0), 150);
    return;
  }

  let exitCode = 1;
  let handlerFound = false;
  try {
    for (const handler of [runProjects, runDispatch, runSession, runNotify,
                            runProgress, runStage, runRows, runQueue]) {
      const result = await handler(cmd, argv);
      if (result !== null && result !== undefined) {
        exitCode = result;
        handlerFound = true;
        break;
      }
    }
    if (!handlerFound) {
      process.stderr.write(
        `pipeline: unknown subcommand "${cmd}"\n\nRun \`pipeline --help\` for usage.\n`
      );
    }
  } catch (e) {
    process.stderr.write(e.message + "\n");
    exitCode = 1;
  }

  setTimeout(() => process.exit(exitCode), 150);
})().catch(e => { process.stderr.write(e.message + "\n"); process.exit(1); });

// ─────────────────────────────────────────────────────────────────────────────
// Flag parsing for `pipeline setup --non-interactive …`. Designed so a future
// Claude (or CI) can drive setup without prompts; supports the same surface as
// the interactive wizard's questions.
//
// Flag reference:
//   --non-interactive          run without any prompts (required for the
//                              rest of these flags to take effect; in
//                              interactive mode the wizard ignores them).
//   --models r=...,d=...,q=... override model defaults (comma-sep key=val
//                              pairs; keys are the column names: r/d/q/rvw).
//   --review-skill <name>      override review.skill (e.g. "ultrareview").
//   --review-deep-flag <flag>  override review.deep_flag ("" to clear).
//   --plans-dir <path>         override plansDir (e.g. "../CLAUDE/repos/{project}/plans").
//   --slack <channel>          set Slack channel ("" to disable).
//   --register-project N:P     register a project (repeatable; N=name, P=abs path).
//   --no-deps                  skip npm install.
//   --no-autostart             skip OS autostart install.
//   --no-path-alias            skip appending pipeline alias to shell profile.
//   --continue-on-failed-prechecks  continue setup even if doctor reports failures.
function _parseSetupOpts(argv) {
  const has = (k) => argv.includes(k);
  const get = (k) => getFlag(k, argv);
  const opts = { nonInteractive: has("--non-interactive") };
  if (!opts.nonInteractive) return opts;

  // Per-model overrides — comma-sep key=val pairs.
  const modelsRaw = get("--models");
  if (modelsRaw) {
    opts.models = {};
    for (const pair of modelsRaw.split(",")) {
      const [k, ...rest] = pair.split("=");
      if (k && rest.length) opts.models[k.trim()] = rest.join("=").trim();
    }
  }
  const rs = get("--review-skill");      if (rs !== null) opts.reviewSkill = rs;
  const rdf = get("--review-deep-flag"); if (rdf !== null) opts.reviewDeepFlag = rdf;
  const pd = get("--plans-dir");         if (pd !== null) opts.plansDir = pd;
  // `--governance-channel` is the new name; `--slack` kept as a deprecated alias
  // for one release so existing setup scripts don't break. wizard prefers new.
  const gc = get("--governance-channel"); if (gc !== null) opts.governanceChannel = gc;
  const sc = get("--slack");              if (sc !== null) opts.slackChannel      = sc;
  const pc = get("--pipeline-channel");   if (pc !== null) opts.pipelineChannel   = pc;
  const mh = get("--merge-hook");         if (mh !== null) opts.mergeHook         = mh;
  const om = get("--on-merge");           if (om !== null) opts.onMerge           = om;

  // --register-project Name:Absolute/Path/To/Repo (repeatable; loop argv)
  opts.registerProjects = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--register-project" && i + 1 < argv.length) {
      const raw = argv[i + 1];
      const idx = raw.indexOf(":");
      if (idx > 0) {
        opts.registerProjects.push({ name: raw.slice(0, idx), rootPath: raw.slice(idx + 1) });
      }
    }
  }
  if (has("--no-deps"))       opts.installDeps        = false;
  if (has("--no-autostart"))  opts.installAutostart   = false;
  if (has("--no-path-alias")) opts.installPathAlias   = false;
  if (has("--continue-on-failed-prechecks")) opts.continueOnFailedPrechecks = true;
  return opts;
}
