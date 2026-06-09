import { createInterface } from "node:readline/promises";
import {
  readFileSync, writeFileSync, renameSync,
  mkdirSync, existsSync, appendFileSync, readdirSync,
} from "node:fs";
import { execSync } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadPipelineConfig } from "../pipeline-config.mjs";
import { PIPELINE_DEFAULTS } from "../config-defaults.mjs";
import { renderTemplate, installAutostart, verifyAutostart } from "./autostart.mjs";
import { runDoctor, printDoctor } from "./doctor.mjs";
import { connectUnified, close as dbClose, projectAdd } from "../../scripts/pipeline-db/index.mjs";

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
    say("Step 1/9 — Environment check\n");
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
    say("Step 2/9 — Model defaults\n");
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
    say("Step 3/9 — Review skill config\n");
    config.review = config.review ?? {};
    const defSkill = defaults.review?.skill     ?? PIPELINE_DEFAULTS.review.skill;
    const defFlag  = defaults.review?.deep_flag ?? PIPELINE_DEFAULTS.review.deep_flag;
    config.review.skill = nonInteractive
      ? (opts.reviewSkill || defSkill)
      : ((await ask(`  review.skill [${defSkill}]: `)).trim() || defSkill);
    config.review.deep_flag = nonInteractive
      ? (opts.reviewDeepFlag !== undefined ? opts.reviewDeepFlag : defFlag)
      : ((await ask(`  review.deep_flag (extra flag for review skill, or blank for none) [${defFlag || "(none)"}]: `)).trim() || defFlag);

    // plansDir — where plan files live (relative to each project root)
    const defPlansDir = defaults.plansDir ?? PIPELINE_DEFAULTS.plansDir;
    if (!nonInteractive) {
      say("\n  Plan files location (plansDir):\n");
      say("    Default 'plans' → <project-root>/plans/\n");
      say("    Use {project} for a separate knowledge-base repo, e.g.:\n");
      say("      ../CLAUDE/repos/{project}/plans\n");
    }
    const plansDirRaw = nonInteractive
      ? (opts.plansDir !== undefined ? opts.plansDir : defPlansDir)
      : ((await ask(`  plansDir [${defPlansDir}]: `)).trim() || defPlansDir);
    config.plansDir = plansDirRaw || defPlansDir;

    // Step 5 — Slack notification channels
    hr();
    say("Step 4/9 — Slack notification channels\n");
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
      const slackOk = (() => {
        // 1) CLAUDE_SLACK_PLUGIN env override — same precedence doctor uses.
        if (process.env.CLAUDE_SLACK_PLUGIN && existsSync(process.env.CLAUDE_SLACK_PLUGIN)) return true;
        // 2) Standard plugin-marketplace install location. Robust to both
        //    PowerShell (function alias, not on PATH) AND mingw bash (PATH
        //    has POSIX separators that the Win path walk can't decode).
        const home = process.env.USERPROFILE || process.env.HOME || homedir();
        const candidatesGlob = join(home, ".claude", "plugins", "cache");
        if (existsSync(candidatesGlob)) {
          try {
            for (const owner of readdirSync(candidatesGlob)) {
              const sb = join(candidatesGlob, owner, "slack-bridge");
              if (!existsSync(sb)) continue;
              for (const ver of readdirSync(sb)) {
                const exe = join(sb, ver, "bin", "claude-slack.mjs");
                if (existsSync(exe)) return true;
              }
            }
          } catch {}
        }
        // 3) PATH walk with extensions (last-ditch — works when claude-slack
        //    is a real binary or .cmd shim on a sane shell). Splits on BOTH
        //    `;` (Windows) and `:` (mingw bash) to survive either env.
        const dirs = (process.env.PATH || "").split(/[;:]/);
        const exts = process.platform === "win32" ? [".exe", ".cmd", ".bat", ".mjs", ".js", ""] : [""];
        for (const d of dirs) {
          if (!d) continue;
          for (const ext of exts) {
            if (existsSync(join(d, "claude-slack" + ext))) return true;
          }
        }
        return false;
      })();
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
      let mergeHook;
      if (nonInteractive) {
        mergeHook = opts.mergeHook !== undefined ? (opts.mergeHook || null) : defMergeHook;
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
      let onMerge;
      if (nonInteractive) {
        onMerge = opts.onMerge !== undefined ? (opts.onMerge || null) : defOnMerge;
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

    // Step 6 — write config (atomic .tmp → rename)
    mkdirSync(paths.configDir, { recursive: true });
    const tmpPath = configPath + ".tmp";
    writeFileSync(tmpPath, JSON.stringify(config, null, 2), { mode: 0o600 });
    renameSync(tmpPath, configPath);
    say(`\nConfig written to: ${configPath}`);

    // Step 7 — register first project
    hr();
    say("Step 5/9 — Register first project\n");
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

    // Step 8 — autostart
    hr();
    say("Step 6/9 — Autostart\n");
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
    say("Step 7/9 — Add pipeline to PATH\n");
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
    say("Step 8/9 — Smoke test\n");
    const smokeResults = await runDoctor({ paths });
    printDoctor(smokeResults);
    const failed = smokeResults.filter(r => !r.ok && !r.warn);

    // Step 11 — launch hint
    hr();
    say("Step 9/9 — Done\n");
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
