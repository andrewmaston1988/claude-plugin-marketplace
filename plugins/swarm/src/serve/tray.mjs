// The Windows tray: the icon it shows, and the argv it is launched with.
//
// Its own module because two callers need it and they must not drift — the start
// path (`serve`, `serve restart`, `serve --daemon`), and the DISABLED path, where
// the tray is the only thing that starts: it is the one surface that can turn the
// dashboard back on, so it must outlive the switch that turned it off.
import { spawn } from "node:child_process";
import { writeFileSync, renameSync, appendFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { pidPath } from "./daemon.mjs";
import { renderTrayIconPng } from "./icon.mjs";

export async function launchTray({ home, port, shimPath = join(home, "serve.mjs"), tray = true, nodeExe = process.execPath, platform = process.platform, env = process.env } = {}) {
  if (platform !== "win32" || tray === false) return { ok: true, skipped: true };
  try {
    const iconPath = join(home, "dashboard-icon.png");
    writeFileSync(`${iconPath}.tmp`, renderTrayIconPng());
    renameSync(`${iconPath}.tmp`, iconPath);
    const trayScript = fileURLToPath(new URL("./tray.ps1", import.meta.url));
    // The tray needs a console — powershell.exe is a console-subsystem exe whose
    // WinForms message loop dies without one, and `detached: true` strips it
    // (DETACHED_PROCESS) — and it must outlive the short-lived parent that spawned
    // it: `cmd /c start` gives it a fresh hidden console AND breaks it out of our
    // job. Same shape as slack-bridge claude-slack.mjs:245-270; its Task-Scheduler
    // reason does not apply here (swarm autostarts from the Startup folder), but
    // the console and breakaway halves both do.
    const trayArgs = ["/c", "start", "", "/min", "powershell.exe", "-WindowStyle", "Hidden", "-NonInteractive",
      "-File", trayScript, "-PidFile", pidPath(home), "-NodeExe", nodeExe, "-ShimPath", shimPath,
      "-Port", String(port), "-IconPath", iconPath, "-SwarmHome", home];
    // Test-only seam, armed only under `node --test` (NODE_TEST_CONTEXT), the same
    // shape as swarm.mjs's SWARM_SERVE_TEST_CRASH: a real NotifyIcon would land on
    // the operator's desktop every time the suite runs. Records the argv it WOULD run.
    if (env.NODE_TEST_CONTEXT && env.SWARM_SERVE_TEST_TRAY) {
      appendFileSync(env.SWARM_SERVE_TEST_TRAY, `${JSON.stringify({ argv: trayArgs })}\n`);
      return { ok: true, recorded: true };
    }
    const child = spawn("cmd.exe", trayArgs, { detached: true, stdio: "ignore", windowsHide: true });
    child.unref();
    return { ok: true };
  } catch (e) { return { ok: false, reason: `tray not started: ${e.message}` }; }
}
