import { readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";

const execFileAsync = promisify(execFile);
const TEMPLATES_DIR = join(dirname(fileURLToPath(import.meta.url)), "../../autostart-templates");

const TASK_NAME = "ClaudePipelineOrchestrator";
const PLIST_ID  = "com.claudepipeline.orchestrator";
const UNIT_NAME = "claude-pipeline";

export function renderTemplate(platform, { nodePath, bridgeEntry, configDir, logDir }) {
  const filename = {
    win32:  "windows-task.xml",
    darwin: "macos-launchd.plist",
    linux:  "linux-systemd.service",
  }[platform];
  if (!filename) throw new Error(`Unsupported platform: ${platform}`);

  let content = readFileSync(join(TEMPLATES_DIR, filename), "utf8");
  content = content
    .replace(/\$\{NODE_PATH\}/g,    nodePath)
    .replace(/\$\{BRIDGE_ENTRY\}/g, bridgeEntry)
    .replace(/\$\{CONFIG_DIR\}/g,   configDir)
    .replace(/\$\{LOG_DIR\}/g,      logDir);
  return content;
}

export async function installAutostart(platform, renderedContent, { log: _log } = {}) {
  if (platform === "win32") {
    const tmp = join(homedir(), "AppData", "Local", "Temp", "claude-pipeline-task.xml");
    writeFileSync(tmp, renderedContent, "utf8");
    try {
      await execFileAsync("schtasks", [
        "/Create", "/XML", tmp, "/TN", TASK_NAME, "/F",
      ], { timeout: 15_000 });
    } finally {
      try { unlinkSync(tmp); } catch { /* ignore */ }
    }
    return;
  }

  if (platform === "darwin") {
    const plistDir = join(homedir(), "Library", "LaunchAgents");
    const plistPath = join(plistDir, `${PLIST_ID}.plist`);
    writeFileSync(plistPath, renderedContent, "utf8");
    await execFileAsync("launchctl", ["load", "-w", plistPath], { timeout: 10_000 });
    return;
  }

  if (platform === "linux") {
    const unitDir = join(homedir(), ".config", "systemd", "user");
    const unitPath = join(unitDir, `${UNIT_NAME}.service`);
    writeFileSync(unitPath, renderedContent, "utf8");
    await execFileAsync("systemctl", ["--user", "daemon-reload"], { timeout: 10_000 });
    await execFileAsync("systemctl", ["--user", "enable", "--now", UNIT_NAME], { timeout: 10_000 });
    return;
  }

  throw new Error(`installAutostart: unsupported platform ${platform}`);
}

export async function uninstallAutostart(platform) {
  if (platform === "win32") {
    try {
      await execFileAsync("schtasks", ["/Delete", "/TN", TASK_NAME, "/F"], { timeout: 10_000 });
    } catch { /* ignore if not registered */ }
    return;
  }

  if (platform === "darwin") {
    const plistPath = join(homedir(), "Library", "LaunchAgents", `${PLIST_ID}.plist`);
    try {
      await execFileAsync("launchctl", ["unload", "-w", plistPath], { timeout: 10_000 });
    } catch { /* ignore if not loaded */ }
    try { unlinkSync(plistPath); } catch { /* ignore if already gone */ }
    return;
  }

  if (platform === "linux") {
    try {
      await execFileAsync("systemctl", ["--user", "disable", "--now", UNIT_NAME], { timeout: 10_000 });
    } catch { /* ignore if not enabled */ }
    const unitPath = join(homedir(), ".config", "systemd", "user", `${UNIT_NAME}.service`);
    try { unlinkSync(unitPath); } catch { /* ignore */ }
    await execFileAsync("systemctl", ["--user", "daemon-reload"], { timeout: 10_000 });
    return;
  }

  throw new Error(`uninstallAutostart: unsupported platform ${platform}`);
}

export async function verifyAutostart(platform) {
  try {
    if (platform === "win32") {
      const { stdout } = await execFileAsync(
        "schtasks", ["/Query", "/TN", TASK_NAME, "/FO", "LIST"],
        { timeout: 5_000 },
      );
      return { ok: stdout.includes(TASK_NAME), detail: "Task Scheduler entry found" };
    }

    if (platform === "darwin") {
      const { stdout } = await execFileAsync(
        "launchctl", ["list", PLIST_ID],
        { timeout: 5_000 },
      );
      return { ok: !!stdout.trim(), detail: "LaunchAgent loaded" };
    }

    if (platform === "linux") {
      await execFileAsync("systemctl", ["--user", "is-enabled", UNIT_NAME], { timeout: 5_000 });
      return { ok: true, detail: "systemd unit enabled" };
    }

    return { ok: false, detail: `unsupported platform: ${platform}` };
  } catch (e) {
    return { ok: false, detail: e.message };
  }
}
