import { createInterface } from "node:readline/promises";
import {
  readFileSync, writeFileSync, renameSync,
  mkdirSync, existsSync, appendFileSync,
} from "node:fs";
import { execSync } from "node:child_process";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { loadPipelineConfig } from "../pipeline-config.mjs";
import { PIPELINE_DEFAULTS } from "../config-defaults.mjs";
import { renderTemplate, installAutostart, verifyAutostart } from "./autostart.mjs";
import { runDoctor, printDoctor } from "./doctor.mjs";
import { connectUnified, close as dbClose, projectAdd, projectList } from "../../scripts/pipeline-db/index.mjs";
import { findClaudeSlackPlugin } from "../locators/claude-slack.mjs";
import { detectDefaultBranch } from "../cli/helpers.mjs";

// Non-interactive defaults — applied when `opts.nonInteractive === true` and the
// caller didn't override the specific key. Designed so a future Claude (or CI)
// can run the wizard end-to-end without any prompts.
const NI_DEFAULTS = Object.freeze({
  overwriteExisting:  true,
  installDeps:        true,
  continueOnFailedPrechecks: false,
  installAutostart:   true,
  installPathAlias:   true,
  // models, reviewSkill, reviewDeepFlag, slackChannel: pulled from config defaults
  // registerProjects: []
});

export async function runWizard({ paths, log, opts = {} }) {
  const nonInteractive = opts.nonInteractive === true;
  // Refuse to start an interactive wizard without a TTY — readline.question
  // hangs and then throws "readline was closed" when stdin EOFs.
  if (!nonInteractive && !process.stdin.isTTY) {
    process.stderr.write(
      "pipeline setup: stdin is not a TTY — interactive wizard would hang.\n" +
      "  Re-run in a terminal, or pass --non-interactive (with optional --models, --slack, --register-project, etc).\n"
    );
    return;
  }

  const rl  = nonInteractive ? null : createInterface({ input: process.stdin, output: process.stdout });
  const ask = (q) => rl.question(q);
  const say = (s) => process.stdout.write(s + "\n");
  const hr  = ()  => say("\n" + "─".repeat(60));
  // True iff non-interactive *and* the caller explicitly asked for it (or NI default says yes).
  const niYes = (key) => opts[key] !== undefined ? !!opts[key] : !!NI_DEFAULTS[key];

  try {
    hr();
    say("Welcome to claude-pipeline setup!");
    say(nonInteractive
      ? "Running in non-interactive mode (defaults + flags only)."
      : "This wizard will configure the Pipeline orchestrator plugin.");
    hr();

    // Step 1 — detect existing config
    const configPath = join(paths.configDir, "config.json");
    let existing = null;
    if (existsSync(configPath)) {
      try {
        existing = JSON.parse(readFileSync(configPath, "utf8"));
        say(`\nExisting config found at: ${configPath}`);
        const overwrite = nonInteractive
          ? (niYes("overwriteExisting") ? "y" : "n")
          : await ask("Overwrite it? [y/N] ");
        if (!overwrite.trim().toLowerCase().startsWith("y")) {
          say("Setup cancelled — keeping existing config.");
          return;
        }
      } catch {
        say("Existing config unreadable — will create a new one.");
      }
    }

    const defaults = loadPipelineConfig();
    const config   = existing ? JSON.parse(JSON.stringify(existing)) : {};

    // Step 1.5 — install runtime npm dependencies (blessed + postinstall patches).
    // Hidden behind setup so users never have to know about it; idempotent if
    // already installed.
    if (niYes("installDeps")) {
      hr();
      say("Installing runtime dependencies (blessed + postinstall patches)...");
      try {
        const pluginDir = fileURLToPath(new URL("../..", import.meta.url));
        execSync("npm install --no-audit --no-fund --silent", {
          cwd: pluginDir, stdio: "inherit",
        });
        say("  ✓ dependencies installed");
      } catch (e) {
        say(`  ⚠ npm install failed: ${e.message}`);
        say("  The dashboard TUI requires blessed. Run `npm install` in the plugin dir, then re-run setup.");
        const cont = nonInteractive
          ? "n"
          : await ask("\nContinue setup anyway (TUI dashboard will be unavailable)? [y/N] ");
        if (!cont.trim().toLowerCase().startsWith("y")) return;
      }
    }

    // Step 2 — environment pre-checks
    hr();
    say("Step 1/11 — Environment check\n");
    const preResults = await runDoctor({ paths });
    printDoctor(preResults);
    const preFailed = preResults.filter(r => !r.ok && !r.warn);
    if (preFailed.length > 0) {
      const cont = nonInteractive
        ? (niYes("continueOnFailedPrechecks") ? "y" : "n")
        : await ask(`\n${preFailed.length} check(s) failed. Continue anyway? [y/N] `);
      if (!cont.trim().toLowerCase().startsWith("y")) {
        say("Setup cancelled — fix the issues above and re-run.");
        return;
      }
    }

    // Step 3 — model defaults
    hr();
    say("Step 2/11 — Model defaults\n");
    if (!nonInteractive) say("Press Enter to keep the default, or type a model ID to override.\n");
    config.models = config.models ?? {};
    for (const [key, defVal] of Object.entries(PIPELINE_DEFAULTS.models)) {
      const current = config.models[key] ?? defVal;
      const override = opts.models && opts.models[key];
      const chosen = nonInteractive
        ? (override || current)
        : ((await ask(`  ${key} [${current}]: `)).trim() || current);
      config.models[key] = chosen;
    }

    // Step 4 — review skill config
    hr();
    say("Step 3/11 — Review skill config\n");
    config.review = config.review ?? {};
    const defSkill = defaults.review?.skill     ?? PIPELINE_DEFAULTS.review.skill;
    const defFlag  = defaults.review?.deep_flag ?? PIPELINE_DEFAULTS.review.deep_flag;
    config.review.skill = nonInteractive
      ? (opts.reviewSkill || defSkill)
      : ((await ask(`  review.skill [${defSkill}]: `)).trim() || defSkill);
    config.review.deep_flag = nonInteractive
      ? (opts.reviewDeepFlag !== undefined ? opts.reviewDeepFlag : defFlag)
      : ((await ask(`  review.deep_flag (extra flag for review skill, or blank for none) [${defFlag || "(none)"}]: `)).trim() || defFlag);

    // plansDir — where plan files live. Templates may reference any of:
    //   {root}             — the project root path
    //   {root_parent}      — the project root's parent directory
    //   {root_grandparent} — two levels above the project root
    //   {project}          — the project name
    // Leading `~/` expands to the home directory; absolute paths pass through.
    const defPlansDir = defaults.plansDir ?? PIPELINE_DEFAULTS.plansDir;
    if (!nonInteractive) {
      say("\n  Plan files location (plansDir):\n");
      say("    Default 'plans' → <project-root>/plans/\n");
      say("    Placeholders: {root}, {root_parent}, {root_grandparent}, {project}.\n");
      say("    Examples:\n");
      say("      {root_parent}/<my-kb>/repos/{project}/plans (sibling knowledge-base repo)\n");
      say("      {root_parent}/shared-plans       (sibling dir at root's parent)\n");
      say("      ~/work/plans/{project}           (absolute, ~-expanded)\n");
      say("    Consequences: an unknown placeholder is left literal in the path,\n");
      say("    so a typo will produce a directory name like '{projetc}' you can spot.\n");
    }
    const plansDirRaw = nonInteractive
      ? (opts.plansDir !== undefined ? opts.plansDir : defPlansDir)
      : ((await ask(`  plansDir [${defPlansDir}]: `)).trim() || defPlansDir);
    config.plansDir = plansDirRaw || defPlansDir;
    // Surface unknown placeholders to the operator without rejecting input.
    const PLANS_DIR_PLACEHOLDERS = new Set(["root", "root_parent", "root_grandparent", "project"]);
    const unknown = [...String(config.plansDir).matchAll(/\{([a-z_]+)\}/gi)]
      .map(m => m[1])
      .filter(p => !PLANS_DIR_PLACEHOLDERS.has(p));
    if (unknown.length && !nonInteractive) {
      say(`    ⚠ unknown placeholder(s): ${[...new Set(unknown)].map(p => `{${p}}`).join(" ")} — will render literally.\n`);
    }

    // Branch conventions — recognised target-branch type prefixes.
    const defTypes = defaults.recognised_branch_types ?? PIPELINE_DEFAULTS.recognised_branch_types;
    let detectedDefault = null;
    try {
      const briefDb = connectUnified(paths);
      try {
        const projs = projectList(briefDb);
        if (projs && projs.length) {
          detectedDefault = detectDefaultBranch(projs[0].root_path);
        }
      } finally { dbClose(briefDb); }
    } catch { /* fresh setup, no DB yet */ }
    if (!nonInteractive) {
      say("\n  Branch conventions:");
      if (detectedDefault) {
        say(`    Detected default branch (first registered project): ${detectedDefault}`);
      } else {
        say("    No project registered yet — detected default will be computed per-project at queue time.");
      }
      say(`    recognised_branch_types — comma-separated prefixes treated as orchestration branches.`);
      say(`    Unrecognised prefixes warn (not error) at queue time.\n`);
    }
    const typesRaw = nonInteractive
      ? (opts.recognisedBranchTypes !== undefined ? opts.recognisedBranchTypes : defTypes.join(","))
      : ((await ask(`  recognised_branch_types [${defTypes.join(",")}]: `)).trim() || defTypes.join(","));
    config.recognised_branch_types = String(typesRaw)
      .split(",").map(s => s.trim()).filter(Boolean);

    // Step 5 — Slack notification channels
    hr();
    say("Step 4/11 — Slack notification channels\n");
    if (!nonInteractive) {
      say("  The slack-bridge reads tokens from env vars (highest priority) or config.json.\n");
      say("  Env var ↔ config key mapping:\n");
      say("    SLACK_BOT_TOKEN  →  tokens.bot   (required)\n");
      say("    SLACK_APP_TOKEN  →  tokens.app   (required for Socket Mode)\n");
      say("    CLAUDE_CWD       →  claude.cwd   (optional; sets working dir for claude)\n");
      say("  Set the env vars for secrets; use config.json for non-secret defaults.\n\n");
    }
    config.notifications = config.notifications ?? {};
    // Backward-compat: read pre-rename `slack_channel` as a fallback default.
    const defChannel    = defaults.notifications?.governance_channel
                       ?? defaults.notifications?.slack_channel
                       ?? null;
    const defPipeline   = defaults.notifications?.pipeline_channel ?? null;
    let channelVal;
    let pipelineVal;
    if (nonInteractive) {
      // opts.governanceChannel / opts.slackChannel: "" / null → disabled. undefined → use existing default.
      const optChannel = opts.governanceChannel !== undefined ? opts.governanceChannel : opts.slackChannel;
      channelVal = optChannel !== undefined
        ? (optChannel ? String(optChannel).replace(/^#/, "") : null)
        : defChannel;
      pipelineVal = opts.pipelineChannel !== undefined
        ? (opts.pipelineChannel ? String(opts.pipelineChannel).replace(/^#/, "") : null)
        : defPipeline;
    } else {
      const channelRaw = await ask(
        `  Governance channel (cache/daily reports etc, no '#', blank to disable) [${defChannel ?? "(disabled)"}]: `
      );
      channelVal = channelRaw.trim().replace(/^#/, "") || defChannel || null;
      const pipelineRaw = await ask(
        `  Pipeline channel (orchestrator pings, blank = use governance) [${defPipeline ?? channelVal ?? "(disabled)"}]: `
      );
      pipelineVal = pipelineRaw.trim().replace(/^#/, "") || defPipeline || null;
    }
    config.notifications.governance_channel = channelVal;
    config.notifications.pipeline_channel   = pipelineVal;
    // Clean up legacy key if present in the on-disk config from a prior version.
    delete config.notifications.slack_channel;

    // Auto-wire the bundled claude-slack forwarder as on_write if a channel is
    // configured AND claude-slack is on PATH. User can later replace
    // on_write with a custom forwarder; setup won't clobber a non-default
    // hook on re-run.
    if (channelVal || pipelineVal) {
      const forwarder = fileURLToPath(new URL("../../scripts/forwarders/claude-slack.mjs", import.meta.url));
      const bundledMarker = "/forwarders/claude-slack.mjs";
      const slackOk = !!findClaudeSlackPlugin().path;
      const existing = config.hooks?.on_notification || config.notifications?.on_write || "";
      // Only set if unset or already pointing at our bundled forwarder — never
      // overwrite a custom user forwarder.
      if (slackOk && (!existing || existing.includes(bundledMarker))) {
        if (!config.hooks) config.hooks = {};
        config.hooks.on_notification = forwarder;
        say(`  ✓ on_notification wired to bundled claude-slack forwarder`);
      } else if (!slackOk) {
        say(`  ⚠ claude-slack not on PATH — Slack notifications won't fire until installed.`);
      } else {
        say(`  ✓ on_notification left as custom hook: ${existing}`);
      }
    }

    // on_merge_ready hook — fires when a row reaches stage=merge (all projects, regardless of autoMerge).
    {
      const defMergeHook = config.hooks?.on_merge_ready ?? null;
      const existingMergeReadyFile = join(homedir(), ".pipeline", "hooks", "on-merge-ready.mjs");
      let mergeHook;
      if (nonInteractive) {
        mergeHook = opts.mergeHook !== undefined ? (opts.mergeHook || null) : defMergeHook;
      } else if (!defMergeHook && existsSync(existingMergeReadyFile)) {
        say(`\n  Found existing hook at ${existingMergeReadyFile}`);
        const wire = await ask("  Wire this into config? [Y/n]: ");
        mergeHook = wire.trim().toLowerCase() === "n" ? null : existingMergeReadyFile;
        if (!mergeHook) {
          say("\n  on_merge_ready hook (optional — fires when a row reaches stage=merge).");
          say("  Provide an absolute path to a script/executable, or blank to skip.");
          const raw = await ask(`  on_merge_ready [${defMergeHook ?? "(none)"}]: `);
          mergeHook = raw.trim() || null;
        }
      } else {
        say("\n  on_merge_ready hook (optional — fires when a row reaches stage=merge).");
        say("  Provide an absolute path to a script/executable, or blank to skip.");
        const raw = await ask(`  on_merge_ready [${defMergeHook ?? "(none)"}]: `);
        mergeHook = raw.trim() || defMergeHook || null;
      }
      if (!config.hooks) config.hooks = {};
      if (mergeHook) {
        config.hooks.on_merge_ready = mergeHook;
        say(`  ✓ on_merge_ready: ${mergeHook}`);
      } else if (config.hooks.on_merge_ready) {
        say(`  ✓ on_merge_ready kept: ${config.hooks.on_merge_ready}`);
      } else {
        say("  on_merge_ready not configured — skipped.");
      }
    }

    // on_merge hook — replaces the local squash merge when set; hook owns the git operation.
    {
      const defOnMerge = config.hooks?.on_merge ?? null;
      const existingMergeFile = join(homedir(), ".pipeline", "hooks", "on-merge.mjs");
      let onMerge;
      if (nonInteractive) {
        onMerge = opts.onMerge !== undefined ? (opts.onMerge || null) : defOnMerge;
      } else if (!defOnMerge && existsSync(existingMergeFile)) {
        say(`\n  Found existing hook at ${existingMergeFile}`);
        const wire = await ask("  Wire this into config? [Y/n]: ");
        onMerge = wire.trim().toLowerCase() === "n" ? null : existingMergeFile;
        if (!onMerge) {
          say("\n  on_merge hook (optional — replaces the local squash merge when set).");
          say("  Provide an absolute path to a script/executable, or blank to keep local squash.");
          const raw = await ask(`  on_merge [${defOnMerge ?? "(none — local squash)"}]: `);
          onMerge = raw.trim() || null;
        }
      } else {
        say("\n  on_merge hook (optional — replaces the local squash merge when set).");
        say("  Provide an absolute path to a script/executable, or blank to keep local squash.");
        const raw = await ask(`  on_merge [${defOnMerge ?? "(none — local squash)"}]: `);
        onMerge = raw.trim() || defOnMerge || null;
      }
      if (!config.hooks) config.hooks = {};
      if (onMerge) {
        config.hooks.on_merge = onMerge;
        say(`  ✓ on_merge: ${onMerge}`);
      } else if (config.hooks.on_merge) {
        say(`  ✓ on_merge kept: ${config.hooks.on_merge}`);
      } else {
        say("  on_merge not configured — local squash merge used.");
      }
    }

    // Migrate legacy notifications.on_write → hooks.on_notification (cleanup).
    if (config.notifications?.on_write) {
      delete config.notifications.on_write;
    }

    // Step 5/11 — web dashboard port
    hr();
    say("Step 5/11 — Web dashboard port\n");
    {
      const defPort = config.web?.port ?? PIPELINE_DEFAULTS.web.port;
      if (!nonInteractive) {
        say(`  The pipeline web dashboard (http://localhost:<port>/pipeline) listens on this port.\n`);
        say(`  Default: ${defPort}. Change it if another service already occupies ${defPort}.\n`);
        say(`  Bookmarks and scripts that reference a specific port will need updating if you change it.\n`);
        say(`  Example: http://localhost:9000/pipeline\n`);
      }
      const portRaw = nonInteractive
        ? (opts.webPort !== undefined ? String(opts.webPort) : "")
        : (await ask(`  web.port [${defPort}]: `)).trim();
      const portVal = portRaw ? parseInt(portRaw, 10) : defPort;
      if (!isNaN(portVal) && portVal > 0) {
        if (!config.web) config.web = {};
        config.web.port = portVal;
        say(`  ✓ web.port: ${portVal}  →  http://localhost:${portVal}/pipeline\n`);
      }

      const defHost = config.web?.host ?? PIPELINE_DEFAULTS.web.host;
      if (!nonInteractive) {
        say(`\n  web.host controls which network interfaces the dashboard binds to.\n`);
        say(`  "${defHost}" (default) = loopback only — dashboard is not reachable from other machines.\n`);
        say(`  "0.0.0.0" = all interfaces — reachable on your local network (LAN access).\n`);
      }
      const hostRaw = nonInteractive
        ? (opts.webHost !== undefined ? String(opts.webHost) : "")
        : (await ask(`  web.host [${defHost}]: `)).trim();
      const hostVal = hostRaw || defHost;
      if (!config.web) config.web = {};
      config.web.host = hostVal;
      say(`  ✓ web.host: ${hostVal}\n`);
    }

    // Step 7 — register first project (config is written after worktree-layout
    // step so the resolved-default path can use the first registered project's
    // actual root_parent).
    hr();
    say("Step 6/11 — Register first project\n");
    say("The orchestrator dispatches sessions per registered project.");
    if (!nonInteractive) say("You can skip this step and run 'pipeline project-add <name> <path>' later.\n");
    {
      const projDb = connectUnified(paths);
      try {
        let registered = 0;
        if (nonInteractive) {
          for (const { name, rootPath } of (opts.registerProjects ?? [])) {
            try {
              const row = projectAdd(projDb, { name, rootPath });
              registered += 1;
              say(`  ✓ Registered '${row.name}' -> ${row.root_path}`);
            } catch (e) {
              say(`  ✗ ${name}: ${e.message}`);
            }
          }
          if (registered === 0) {
            say("  No projects passed via --register-project — orchestrator stays idle until one is added.");
          }
        } else {
          while (true) {
            const nameRaw = await ask("  Project name (lowercase, hyphens ok; blank to skip): ");
            const name = nameRaw.trim();
            if (!name) {
              if (registered === 0) {
                say("  Skipped — register projects later with: pipeline project-add <name> <path>");
                say("  The orchestrator stays idle until at least one project is registered.");
              }
              break;
            }
            const pathRaw = await ask("  Absolute path to project root: ");
            const rootPath = pathRaw.trim();
            if (!rootPath) {
              say("  ✗ path required — try again, or blank name to skip");
              continue;
            }
            try {
              const row = projectAdd(projDb, { name, rootPath });
              registered += 1;
              say(`  ✓ Registered '${row.name}' -> ${row.root_path}`);
            } catch (e) {
              say(`  ✗ ${e.message}`);
              continue;
            }
            const more = await ask("  Register another? [y/N] ");
            if (!more.trim().toLowerCase().startsWith("y")) break;
          }
        }
      } finally {
        dbClose(projDb);
      }
    }

    // Step 7.5 — Worktree layout. Placed AFTER project registration so the
    // resolved-default path uses the first registered project's actual
    // root_parent (the surface-each-option contract requires showing a
    // concrete resolved default).
    hr();
    say("Step 7/11 — Worktree layout\n");
    const defWtBase     = defaults.worktree_base ?? PIPELINE_DEFAULTS.worktree_base;
    const defReportSub  = defaults.report_subpath ?? PIPELINE_DEFAULTS.report_subpath;
    const defPublishTpl = defaults.report_publish_branch_template
                       ?? PIPELINE_DEFAULTS.report_publish_branch_template;
    const WT_PLACEHOLDERS = new Set([
      "root", "root_parent", "root_grandparent", "project", "feature", "kind",
    ]);
    // Resolve a concrete preview path using the first registered project if any.
    let resolvedExample = defWtBase;
    try {
      const briefDb = connectUnified(paths);
      try {
        const projs = projectList(briefDb);
        if (projs && projs.length) {
          const root    = projs[0].root_path;
          const project = projs[0].name;
          resolvedExample = String(defWtBase)
            .replace(/\{root_grandparent\}/g, dirname(dirname(root)))
            .replace(/\{root_parent\}/g, dirname(root))
            .replace(/\{root\}/g, root)
            .replace(/\{project\}/g, project)
            .replace(/\{feature\}/g, "<feature>");
        }
      } finally { dbClose(briefDb); }
    } catch { /* no DB yet — preview stays as template */ }
    if (!nonInteractive) {
      say("  Where should worktrees live on disk?\n");
      say("    1) Recommended (one worktree per feature, project-namespaced)");
      say(`         paths: <resolved: ${resolvedExample}>`);
      say("         reports inside: reports/ and test-reports/\n");
      say("    2) Custom — type a template string");
      say("         placeholders: {root} {root_parent} {root_grandparent} {project} {feature} {kind}");
      say("         accepts: absolute paths, ~/..., relative-to-project-root\n");
    }
    let wtChoice;
    if (nonInteractive) {
      wtChoice = opts.worktreeLayout ? String(opts.worktreeLayout) : "1";
    } else {
      wtChoice = (await ask("  Choose [1]: ")).trim() || "1";
    }
    if (wtChoice === "2") {
      const customRaw = nonInteractive
        ? (opts.worktreeBase != null ? String(opts.worktreeBase) : defWtBase)
        : (await ask("  Custom template: ")).trim();
      const customTpl = customRaw || defWtBase;
      const unknownWt = [...String(customTpl).matchAll(/\{([a-z_]+)\}/gi)]
        .map(m => m[1])
        .filter(p => !WT_PLACEHOLDERS.has(p));
      if (unknownWt.length && !nonInteractive) {
        say(`    ⚠ unknown placeholder(s): ${[...new Set(unknownWt)].map(p => `{${p}}`).join(" ")} — will render literally.\n`);
      }
      config.worktree_base = customTpl;
    } else {
      config.worktree_base = defWtBase;
    }
    config.report_subpath = JSON.parse(JSON.stringify(defReportSub));
    config.report_publish_branch_template = defPublishTpl;

    // Write config (atomic .tmp → rename). Deferred until after the worktree
    // step so all keys land in one write.
    mkdirSync(paths.configDir, { recursive: true });
    const tmpPath = configPath + ".tmp";
    writeFileSync(tmpPath, JSON.stringify(config, null, 2), { mode: 0o600 });
    renameSync(tmpPath, configPath);
    say(`\nConfig written to: ${configPath}`);

    // Step 8 — autostart
    hr();
    say("Step 8/11 — Autostart\n");
    const nodePath    = process.execPath;
    // Autostart targets the orchestrator entry directly, not the CLI binary.
    // Previously this pointed at bin/pipeline.mjs — the OS scheduler would
    // launch the CLI, which prints "unknown subcommand" and exits 0 with no
    // orchestrator ever running. The CLI bin is the user-facing entry; the
    // orchestrator's index.mjs is the long-running daemon.
    const bridgeEntry = fileURLToPath(new URL("../../scripts/orchestrator/index.mjs", import.meta.url));
    const doAutostart = nonInteractive
      ? (niYes("installAutostart") ? "y" : "n")
      : await ask(`Install autostart for ${process.platform}? [Y/n] `);
    if (!doAutostart.trim().toLowerCase().startsWith("n")) {
      try {
        const rendered = renderTemplate(process.platform, {
          nodePath,
          bridgeEntry,
          configDir: paths.configDir,
          logDir:    paths.logDir,
        });
        await installAutostart(process.platform, rendered, { log });
        const { ok, detail } = await verifyAutostart(process.platform);
        say(`${ok ? "✓" : "✗"} Autostart: ${detail}`);
      } catch (e) {
        say(`✗ Autostart install failed: ${e.message}`);
        say("  You can retry with: pipeline setup");
      }
    } else {
      say("Skipped — run 'pipeline setup' again to install autostart.");
    }

    // Step 9 — PATH alias
    hr();
    say("Step 9/11 — Add pipeline to PATH\n");
    // PATH alias targets the user-facing CLI dispatcher, NOT the daemon entry.
    // bridgeEntry above is scripts/orchestrator/index.mjs (correct for the OS
    // scheduler); for shell aliases users need bin/pipeline.mjs so subcommands
    // like `pipeline dashboard tui` actually dispatch.
    const cliEntry = fileURLToPath(new URL("../../bin/pipeline.mjs", import.meta.url));
    if (process.platform === "win32") {
      let profile = "";
      try { profile = execSync("pwsh -NoProfile -Command $PROFILE", { encoding: "utf8", timeout: 5000 }).trim(); } catch {}
      if (!profile) { try { profile = execSync("powershell -NoProfile -Command $PROFILE", { encoding: "utf8", timeout: 5000 }).trim(); } catch {} }
      const profilePath = profile || "$PROFILE";
      const fn = `function pipeline { & "${nodePath}" "${cliEntry}" @args }`;
      const addIt = nonInteractive
        ? (niYes("installPathAlias") ? "y" : "n")
        : await ask(`Append pipeline function to ${profilePath}? [Y/n] `);
      if (!addIt.trim().toLowerCase().startsWith("n")) {
        try {
          if (profile) {
            const dir = profile.substring(0, profile.lastIndexOf("\\"));
            mkdirSync(dir, { recursive: true });
            appendFileSync(profile, `\n# pipeline (added by setup)\n${fn}\n`);
            say(`✓ Added — restart PowerShell or: . "${profile}"`);
          } else {
            say(`Add this to your PowerShell profile manually:\n  ${fn}`);
          }
        } catch (e) {
          say(`✗ Could not write profile: ${e.message}`);
          say(`Add manually to your PowerShell profile:\n  ${fn}`);
        }

        // ALSO install a .cmd shim in ~/.local/bin so non-interactive shells
        // (Claude Code's Bash/PowerShell tools, CI runners, automation) can
        // invoke `pipeline` without loading the PowerShell user profile.
        // The PS function above is for interactive shells; this shim is
        // for everything else.
        try {
          const userBin = join(homedir(), ".local", "bin");
          mkdirSync(userBin, { recursive: true });
          const cmdShim = `@echo off\r\n"${nodePath}" "${cliEntry}" %*\r\n`;
          writeFileSync(join(userBin, "pipeline.cmd"), cmdShim);
          // Also extensionless for Git Bash / MSYS environments.
          writeFileSync(join(userBin, "pipeline"), `#!/usr/bin/env bash\nexec "${nodePath}" "${cliEntry}" "$@"\n`);
          say(`✓ Installed shim: ${join(userBin, "pipeline.cmd")} (works in all shells if ~/.local/bin is on PATH)`);
        } catch (e) {
          say(`⚠ Could not install ~/.local/bin shim: ${e.message}`);
        }
      } else {
        say(`Add manually to your PowerShell profile:\n  ${fn}`);
      }
    } else {
      const shell  = process.env.SHELL ?? "";
      const rcFile = shell.includes("zsh")
        ? `${process.env.HOME}/.zshrc`
        : `${process.env.HOME}/.bashrc`;
      const alias = `alias pipeline='${nodePath} ${cliEntry}'`;
      const addIt = nonInteractive
        ? (niYes("installPathAlias") ? "y" : "n")
        : await ask(`Append shell alias to ${rcFile}? [Y/n] `);
      if (!addIt.trim().toLowerCase().startsWith("n")) {
        try {
          appendFileSync(rcFile, `\n# pipeline (added by setup)\n${alias}\n`);
          say(`✓ Added — restart shell or: source ${rcFile}`);
        } catch (e) {
          say(`✗ Could not write ${rcFile}: ${e.message}`);
          say(`Add manually:\n  ${alias}`);
        }
      } else {
        say(`Add manually to ${rcFile}:\n  ${alias}`);
      }
    }

    // Step 10 — smoke test
    hr();
    say("Step 10/11 — Smoke test\n");
    const smokeResults = await runDoctor({ paths });
    printDoctor(smokeResults);
    const failed = smokeResults.filter(r => !r.ok && !r.warn);

    // Step 11 — launch hint
    hr();
    say("Step 11/11 — Done\n");
    if (failed.length === 0) {
      say("All checks passed.");
    } else {
      say(`${failed.length} check(s) still failing — review above.`);
    }
    say(`\nRun: node "${cliEntry}" doctor`);
    say("Setup complete!");

  } finally {
    if (rl) { try { rl.close(); } catch { /* already closed */ } }
  }
}
