import { createInterface } from "node:readline/promises";
import { readFileSync, writeFileSync, appendFileSync, existsSync, mkdirSync } from "node:fs";
import { execFile, execSync } from "node:child_process";
import { promisify } from "node:util";
import { join, resolve } from "node:path";
import { renderManifest } from "./manifest.mjs";
import { renderTemplate, installAutostart, verifyAutostart, installStableEntry } from "./autostart.mjs";
import { createWebClient } from "../web-api/index.mjs";
import { runDoctor, printDoctor } from "../doctor/index.mjs";

const execFileAsync = promisify(execFile);

const SLACK_APP_CREATE_URL = "https://api.slack.com/apps?new_app=1";

/**
 * Run the interactive setup wizard.
 *
 * @param {{ paths: object, log: object }} opts
 */
export async function runWizard({ paths, log }) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const ask  = (q)        => rl.question(q);
  const say  = (s)        => process.stdout.write(s + "\n");
  const hr   = ()         => say("\n" + "─".repeat(60));

  try {
    hr();
    say("Welcome to claude-slack setup!");
    say("This wizard will configure the Slack bridge daemon.");
    hr();

    // Step 1: detect existing config
    const configPath = paths.configFile ?? join(paths.configDir, "config.json");
    let existing = null;
    if (existsSync(configPath)) {
      try {
        existing = JSON.parse(readFileSync(configPath, "utf8"));
        say(`\nExisting config found at: ${configPath}`);
        const overwrite = await ask("Overwrite it? [y/N] ");
        if (!overwrite.trim().toLowerCase().startsWith("y")) {
          say("Setup cancelled — keeping existing config.");
          return;
        }
      } catch {
        say("Existing config unreadable — will create a new one.");
      }
    }

    const config = existing
      ? JSON.parse(JSON.stringify(existing))
      : { tokens: {}, claude: {}, slack: {} };

    // Step 2: Slack app manifest
    hr();
    say("Step 1/8 — Create your Slack app\n");
    const displayName = await ask("App display name [Claude Code]: ");
    const manifest = renderManifest({ displayName: displayName.trim() || "Claude Code" });
    say("\nPaste this manifest at " + SLACK_APP_CREATE_URL + "\n");
    say(manifest);
    await ask("\nPress Enter once you've created the app and installed it to your workspace...");

    // Step 3: Token capture
    hr();
    say("Step 2/8 — Token capture\n");
    config.tokens.bot = await captureToken(ask, say, "Bot Token (xoxb-…)", config.tokens.bot, async (t) => {
      const noop = { info() {}, warn() {}, child() { return noop; } };
      const web = createWebClient({ token: t, log: noop });
      const info = await web.authTest();
      return `Authenticated as ${info.user} in ${info.team}`;
    });

    config.tokens.app = await captureToken(ask, say, "App-Level Token (xapp-…)", config.tokens.app, async (t) => {
      const noop = { info() {}, warn() {}, child() { return noop; } };
      const web = createWebClient({ token: config.tokens.bot, log: noop });
      // Quick check — appsConnectionsOpen validates the app token
      const info = await web.appsConnectionsOpen();
      return info.url ? "Socket Mode token ok" : "warning: no WSS URL";
    });

    const userTokenRaw = await ask("User Token (xoxp-…, optional — press Enter to skip): ");
    if (userTokenRaw.trim()) config.tokens.user = userTokenRaw.trim();

    // Step 4: Local config
    hr();
    say("Step 3/8 — Local configuration\n");

    config.claude = config.claude ?? {};
    config.claude.cwd = await captureDir(ask, say, "Claude working directory", config.claude.cwd ?? process.cwd());

    const notifyChannel = await ask("Default notify channel (e.g. #ai-ops, or blank to skip): ");
    if (notifyChannel.trim()) {
      config.slack = config.slack ?? {};
      config.slack.notifyChannel = notifyChannel.trim().replace(/^#/, "");
    }

    const sessionKeyChoice = await ask("Session key strategy: (1) per-channel [default] (2) per-channel-thread: ");
    if (sessionKeyChoice.trim() === "2") {
      config.slack = config.slack ?? {};
      config.slack.sessionKey = "channel-thread";
    }

    // Write config before autostart step (autostart needs the config path)
    mkdirSync(paths.configDir, { recursive: true });
    writeFileSync(configPath, JSON.stringify(config, null, 2), { mode: 0o600 });
    say(`\nConfig written to: ${configPath}`);

    // Step 5: Autostart
    hr();
    say("Step 4/8 — Autostart\n");
    const autostart = await ask(`Install autostart for ${process.platform}? [Y/n] `);
    if (!autostart.trim().toLowerCase().startsWith("n")) {
      try {
        const nodePath  = process.execPath;
        const bridgeEntry = installStableEntry();
        const rendered = renderTemplate(process.platform, {
          nodePath, bridgeEntry,
          configDir: paths.configDir,
          logDir:    paths.logDir,
        });
        await installAutostart(process.platform, rendered, { log });
        const { ok, detail } = await verifyAutostart(process.platform);
        say(`${ok ? "✓" : "✗"} Autostart: ${detail}`);
      } catch (e) {
        say(`✗ Autostart install failed: ${e.message}`);
        say("  You can retry with: claude-slack install-autostart");
      }
    } else {
      say("Skipped — run 'claude-slack install-autostart' later.");
    }

    // Step 5: PATH / shell alias
    hr();
    say("Step 5/8 — Add claude-slack to PATH\n");
    {
      const { fileURLToPath: _ftu } = await import("node:url");
      const entryAbs = _ftu(new URL("../../bin/claude-slack.mjs", import.meta.url));
      const nodeAbs = process.execPath;

      if (process.platform === "win32") {
        let profile = "";
        try { profile = execSync("pwsh -NoProfile -Command $PROFILE", { encoding: "utf8" }).trim(); } catch {}
        if (!profile) { try { profile = execSync("powershell -NoProfile -Command $PROFILE", { encoding: "utf8" }).trim(); } catch {} }
        const profilePath = profile || "$PROFILE";
        const fn = `function claude-slack { & "${nodeAbs}" "${entryAbs}" @args }`;
        const addIt = await ask(`Append claude-slack function to ${profilePath}? [Y/n] `);
        if (!addIt.trim().toLowerCase().startsWith("n")) {
          try {
            if (profile) {
              const dir = profile.substring(0, profile.lastIndexOf("\\"));
              mkdirSync(dir, { recursive: true });
              appendFileSync(profile, `\n# claude-slack (added by setup)\n${fn}\n`);
              say(`✓ Added — restart PowerShell or: . "${profile}"`);
            } else {
              say(`Add this to your PowerShell profile manually:\n  ${fn}`);
            }
          } catch (e) {
            say(`✗ Could not write profile: ${e.message}`);
            say(`Add manually to your PowerShell profile:\n  ${fn}`);
          }
        } else {
          say(`Add manually to your PowerShell profile:\n  ${fn}`);
        }
      } else {
        const shell = process.env.SHELL ?? "";
        const rcFile = shell.includes("zsh")
          ? `${process.env.HOME}/.zshrc`
          : `${process.env.HOME}/.bashrc`;
        const alias = `alias claude-slack='${nodeAbs} ${entryAbs}'`;
        const addIt = await ask(`Append shell alias to ${rcFile}? [Y/n] `);
        if (!addIt.trim().toLowerCase().startsWith("n")) {
          try {
            appendFileSync(rcFile, `\n# claude-slack (added by setup)\n${alias}\n`);
            say(`✓ Added — restart shell or: source ${rcFile}`);
          } catch (e) {
            say(`✗ Could not write ${rcFile}: ${e.message}`);
            say(`Add manually:\n  ${alias}`);
          }
        } else {
          say(`Add manually to ${rcFile}:\n  ${alias}`);
        }
      }
    }

    // Step 6: Extensions
    hr();
    say("Step 6/8 — Extensions (optional)\n");
    say("Enter absolute paths to extension ESM modules, one per line.");
    say("Press Enter on an empty line when done (or just Enter to skip).");
    const extPaths = [];
    for (;;) {
      const p = (await ask("  Extension path: ")).trim();
      if (!p) break;
      const resolved = resolve(p);
      try {
        await import(resolved);
        extPaths.push(resolved);
        say(`  ✓ Loaded: ${resolved}`);
      } catch (e) {
        say(`  ✗ Failed to load: ${e.message} — skipping`);
      }
    }
    if (extPaths.length) {
      config.extensions = extPaths;
      writeFileSync(configPath, JSON.stringify(config, null, 2), { mode: 0o600 });
    }

    // Step 7: Smoke test via doctor
    hr();
    say("Step 7/8 — Smoke test\n");
    const noop = { info() {}, warn() {}, child() { return noop; } };
    const web = createWebClient({ token: config.tokens.bot, log: noop });
    const results = await runDoctor({ config, paths, web, log: noop });
    printDoctor(results);

    const failed = results.filter(r => !r.ok);

    // Step 7: Offer to start
    hr();
    say("Step 8/8 — Launch\n");
    if (failed.length === 0) {
      const start = await ask("Start the bridge daemon now? [Y/n] ");
      if (!start.trim().toLowerCase().startsWith("n")) {
        say("Starting bridge — press Ctrl-C to stop.\n");
        rl.close();
        // Re-exec this process as the bridge
        const { startBridge } = await import("../index.mjs");
        const { createSocketModeClient } = await import("../socket-mode/index.mjs");
        const { createSessionStore } = await import("../session-store/index.mjs");
        const { createQueue } = await import("../core/queue.mjs");
        const { createLogger } = await import("../log.mjs");
        const log2 = createLogger({ logDir: paths.logDir, tag: "bridge" });
        const web2 = createWebClient({ token: config.tokens.bot, log: log2 });
        const socket = createSocketModeClient({ appToken: config.tokens.app, log: log2 });
        const store = createSessionStore({ path: paths.sessionsFile ?? join(paths.dataDir, "sessions.json"), log: log2 });
        const queue = createQueue({ log: log2 });
        startBridge({ config, log: log2, web: web2, socket, store, queue });
        return; // don't close rl twice
      }
    } else {
      say(`\n${failed.length} check(s) failed — fix them before starting the bridge.`);
      say("Re-run: claude-slack doctor");
    }

    say("\nSetup complete! Run: claude-slack start");
  } finally {
    try { rl.close(); } catch { /* already closed */ }
  }
}

async function captureToken(ask, say, label, existing, validate) {
  for (;;) {
    const raw = await ask(`${label}${existing ? ` [keep existing]` : ""}: `);
    const token = raw.trim() || existing;
    if (!token) { say("  Token is required."); continue; }
    try {
      const detail = await validate(token);
      say(`  ✓ ${detail}`);
      return token;
    } catch (e) {
      say(`  ✗ Validation failed: ${e.message}`);
    }
  }
}

async function captureDir(ask, say, label, defaultVal) {
  for (;;) {
    const raw = await ask(`${label} [${defaultVal}]: `);
    const dir = raw.trim() || defaultVal;
    const resolved = resolve(dir);
    try {
      await execFileAsync("claude", ["--version"], { cwd: resolved, timeout: 10_000 });
      say(`  ✓ claude CLI accessible from ${resolved}`);
      return resolved;
    } catch (e) {
      say(`  ✗ claude CLI not accessible: ${e.message}`);
    }
  }
}
