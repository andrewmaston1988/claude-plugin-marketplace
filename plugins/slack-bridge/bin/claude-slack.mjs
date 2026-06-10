#!/usr/bin/env node
import { existsSync, readFileSync, writeFileSync, unlinkSync, mkdirSync } from "node:fs";
import { join as _join } from "node:path";
import { createWebClient } from "../src/web-api/index.mjs";
import { createSocketModeClient } from "../src/socket-mode/index.mjs";
import { createSessionStore } from "../src/session-store/index.mjs";
import { createQueue } from "../src/core/queue.mjs";
import { startBridge } from "../src/index.mjs";
import { createLogger } from "../src/log.mjs";
import { loadConfig } from "../src/config.mjs";
import { getPaths } from "../src/paths.mjs";

function getDefaultPaths() {
  const p = getPaths();
  return {
    ...p,
    configFile: p.configDir + "/config.json",
    sessionsFile: p.dataDir + "/sessions.json",
  };
}

function _pidFile(paths) { return _join(paths.stateDir, "claude-slack.pid"); }
function _writePid(paths) {
  mkdirSync(paths.stateDir, { recursive: true });
  writeFileSync(_pidFile(paths), String(process.pid));
}
function _readPid(paths) {
  const f = _pidFile(paths);
  if (!existsSync(f)) return null;
  return parseInt(readFileSync(f, "utf8").trim(), 10) || null;
}
function _clearPid(paths) { try { unlinkSync(_pidFile(paths)); } catch {} }
function _isAlive(pid) { try { process.kill(pid, 0); return true; } catch { return false; } }

const [,, cmd = "start", ...rest] = process.argv;

(async () => {
if (cmd === "--help" || cmd === "-h") {
  console.log(`
claude-slack — Slack bridge daemon for Claude Code

Usage:
  claude-slack [start] [--daemon] [--config <path>]   Start the bridge (default)
  claude-slack stop                                    Stop a running daemon
  claude-slack status                                  Show running status
  claude-slack notify <channel> <message>              Post a one-shot notification
  claude-slack import-sessions <file.json>             Import sessions from another bridge
  claude-slack manifest [--display-name X] [--include-user-scopes]  Print Slack app manifest YAML
  claude-slack doctor [--json]                         Run diagnostic checks
  claude-slack setup                                   Interactive setup wizard
  claude-slack install-autostart                       Register OS-native autostart entry
  claude-slack uninstall-autostart                     Remove autostart entry
  claude-slack --help                                  Show this help

Environment:
  SLACK_BOT_TOKEN   Override config tokens.bot
  SLACK_APP_TOKEN   Override config tokens.app
  CLAUDE_CWD        Override config claude.cwd
`);
  process.exit(0);
}

if (cmd === "stop") {
  const paths = getDefaultPaths();
  const pid = _readPid(paths);
  if (!pid || !_isAlive(pid)) {
    process.stderr.write("stop: bridge is not running\n");
    process.exitCode = 1;
  } else {
    process.kill(pid, "SIGTERM");
    process.stdout.write(`Sent SIGTERM to PID ${pid}\n`);
    process.exitCode = 0;
  }
  setTimeout(() => process.exit(process.exitCode), 150);
  return;
}

if (cmd === "status") {
  const paths = getDefaultPaths();
  const pid = _readPid(paths);
  if (!pid || !_isAlive(pid)) {
    process.stdout.write("stopped\n");
    process.exitCode = 1;
  } else {
    process.stdout.write(`running (PID ${pid})\n`);
    process.exitCode = 0;
  }
  setTimeout(() => process.exit(process.exitCode), 150);
  return;
}

if (cmd === "setup") {
  const paths = getDefaultPaths();
  const log = createLogger({ logDir: paths.logDir, tag: "setup" });
  const { runWizard } = await import("../src/setup/wizard.mjs");
  await runWizard({ paths, log });
  setTimeout(() => process.exit(0), 150);
  process.exitCode = 0;
  return;
}

if (cmd === "install-autostart") {
  const { fileURLToPath } = await import("node:url");
  const paths = getDefaultPaths();
  const configArg = getFlag("--config", rest) ?? paths.configFile;
  const config = await loadConfig({ configPath: configArg });
  const log = createLogger({ logDir: paths.logDir, tag: "autostart" });
  const { renderTemplate, installAutostart, verifyAutostart } = await import("../src/setup/autostart.mjs");
  const platform = process.platform;
  const nodePath = process.execPath;
  const bridgeEntry = fileURLToPath(new URL("../bin/claude-slack.mjs", import.meta.url));
  const rendered = renderTemplate(platform, { nodePath, bridgeEntry, configDir: paths.configDir, logDir: paths.logDir });
  log.info("installing autostart", { platform });
  process.stdout.write(`Installing autostart for ${platform}...\n`);
  await installAutostart(platform, rendered, { log });
  const { ok, detail } = await verifyAutostart(platform);
  process.stdout.write(`${ok ? "✓" : "✗"} ${detail}\n`);
  setTimeout(() => process.exit(ok ? 0 : 1), 150);
  process.exitCode = ok ? 0 : 1;
  return;
}

if (cmd === "uninstall-autostart") {
  const paths = getDefaultPaths();
  const log = createLogger({ logDir: paths.logDir, tag: "autostart" });
  const { uninstallAutostart } = await import("../src/setup/autostart.mjs");
  const platform = process.platform;
  log.info("uninstalling autostart", { platform });
  process.stdout.write(`Uninstalling autostart for ${platform}...\n`);
  await uninstallAutostart(platform);
  process.stdout.write("Done.\n");
  setTimeout(() => process.exit(0), 150);
  process.exitCode = 0;
  return;
}

if (cmd === "doctor") {
  const paths = getDefaultPaths();
  const configArg = getFlag("--config", rest) ?? paths.configFile;
  const config = await loadConfig({ configPath: configArg });
  const log = createLogger({ logDir: paths.logDir, tag: "doctor" });
  const web = createWebClient({ token: config.tokens.bot, log });
  const { runDoctor, printDoctor } = await import("../src/doctor/index.mjs");
  const results = await runDoctor({ config, paths, web, log });
  printDoctor(results, { json: rest.includes("--json") });
  const exitCode = results.some(c => !c.ok) ? 1 : 0;
  setTimeout(() => process.exit(exitCode), 150);
  process.exitCode = exitCode;
  return;
}

if (cmd === "manifest") {
  const displayName = getFlag("--display-name", rest) ?? "Claude Code";
  const includeUserScopes = rest.includes("--include-user-scopes");
  const { renderManifest } = await import("../src/setup/manifest.mjs");
  process.stdout.write(renderManifest({ displayName, includeUserScopes }));
  process.exit(0);
}

if (cmd === "notify") {
  const paths = getDefaultPaths();
  const configArg = getFlag("--config", rest) ?? paths.configFile;
  const config = await loadConfig({ configPath: configArg });
  const log = createLogger({ logDir: paths.logDir, tag: "notify" });
  const web = createWebClient({ token: config.tokens.bot, log });
  const { runNotifyCli } = await import("../src/notify/cli.mjs");
  const exitCode = await runNotifyCli({ web, log, config, argv: rest });
  // Brief delay lets undici's internal worker-thread async handle (UV_ASYNC)
  // shut down cleanly before libuv teardown — avoids the Windows
  // UV_HANDLE_CLOSING assertion that fires when setImmediate is too fast.
  setTimeout(() => process.exit(exitCode ?? 0), 150);
  process.exitCode = exitCode ?? 0;
  return;
}

if (cmd === "import-sessions") {
  const paths = getDefaultPaths();
  const srcFile = rest[0];
  if (!srcFile) {
    process.stderr.write("import-sessions: <file> argument required\n");
    process.exitCode = 1;
    setTimeout(() => process.exit(1), 150);
    return;
  }
  const log = createLogger({ logDir: paths.logDir, tag: "import" });
  const store = createSessionStore({ path: paths.sessionsFile, log });
  let raw;
  try {
    raw = JSON.parse(readFileSync(srcFile, "utf8"));
  } catch (e) {
    process.stderr.write(`import-sessions: could not parse ${srcFile}: ${e.message}\n`);
    process.exitCode = 1;
    setTimeout(() => process.exit(1), 150);
    return;
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    process.stderr.write("import-sessions: file must contain a JSON object mapping session IDs to values\n");
    process.exitCode = 1;
    setTimeout(() => process.exit(1), 150);
    return;
  }
  const invalid = Object.entries(raw).filter(([, v]) => typeof v !== "string");
  if (invalid.length > 0) {
    process.stderr.write(`import-sessions: ${invalid.length} entry/entries have non-string values — aborting\n`);
    process.exitCode = 1;
    setTimeout(() => process.exit(1), 150);
    return;
  }
  store.importAll(raw);
  const count = Object.keys(raw).length;
  process.stdout.write(`Imported ${count} session(s) from ${srcFile}\n`);
  process.exitCode = 0;
  setTimeout(() => process.exit(0), 150);
  return;
}

// Default: start
const configFlag = getFlag("--config", [cmd, ...rest]);
const paths = getDefaultPaths();
const configPath = configFlag ?? paths.configFile;

let config;
try {
  config = await loadConfig({ configPath });
} catch (e) {
  console.error(`Failed to load config from ${configPath}: ${e.message}`);
  console.error("Run: claude-slack setup");
  process.exit(1);
}

// Daemon mode: fork detached child + tray helper (Windows), then exit
if (rest.includes("--daemon") || rest.includes("-d")) {
  const { fileURLToPath: _ftu } = await import("node:url");
  const entry = _ftu(import.meta.url);
  const { spawn: _sp } = await import("node:child_process");
  const configArgDaemon = configFlag ?? paths.configFile;

  const child = _sp(process.execPath, [entry, "start", "--config", configArgDaemon], {
    detached: true,
    stdio: "ignore",
    env: { ...process.env },
  });
  child.unref();

  if (process.platform === "win32") {
    const trayScript = _ftu(new URL("../src/tray/windows.ps1", import.meta.url));
    // The tray needs TWO things that conflict under Node's spawn flags:
    //   1. A console — powershell.exe is a console-subsystem exe; its WinForms
    //      message loop (Application.Run) dies instantly without one. Node's
    //      `detached: true` sets DETACHED_PROCESS, which STRIPS the console.
    //   2. Job breakaway — Task Scheduler runs this launcher inside a job object
    //      with kill-on-close; a child that stays in the job is terminated when
    //      the launcher exits. `detached: false` keeps the console but stays in
    //      the job, so the tray is killed on task completion.
    // `cmd /c start` resolves both: `start` creates the tray with a NEW (hidden)
    // console AND breaks it out of the launcher's job, so it survives.
    const tray = _sp("cmd.exe", [
      "/c", "start", "", "/min",
      "powershell.exe",
      "-WindowStyle", "Hidden",
      "-NonInteractive",
      "-File", trayScript,
      "-PidFile", _pidFile(paths),
      "-EntryPath", entry,
      "-ConfigPath", configArgDaemon,
      "-NodeExe", process.execPath,
      "-LogDir", paths.logDir,
    ], { detached: true, stdio: "ignore", windowsHide: true });
    tray.unref();
  }

  process.stdout.write(`Bridge started (PID ${child.pid})\n`);
  process.exitCode = 0;
  setTimeout(() => process.exit(0), 150);
  return;
}

const log = createLogger({ logDir: paths.logDir, tag: "bridge" });
const web = createWebClient({ token: config.tokens.bot, log });
const socket = createSocketModeClient({ appToken: config.tokens.app, log });
const store = createSessionStore({ path: paths.sessionsFile, log });
const queue = createQueue({ log });

_writePid(paths);
log.info("starting claude-slack bridge", { configPath, logDir: paths.logDir });

startBridge({ config, log, web, socket, store, queue });

process.on("SIGTERM", () => { log.info("SIGTERM — shutting down"); _clearPid(paths); process.exit(0); });
process.on("SIGINT",  () => { log.info("SIGINT — shutting down");  _clearPid(paths); process.exit(0); });

function getFlag(name, args) {
  const idx = args.indexOf(name);
  return idx !== -1 && idx + 1 < args.length ? args[idx + 1] : undefined;
}
})().catch(e => { process.stderr.write(e.message + "\n"); process.exit(1); });
