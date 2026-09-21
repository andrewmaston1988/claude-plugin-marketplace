// The Windows tray: the icon it shows, and the argv it is launched with.
// Two callers: the start path (`serve`, `serve restart`, `serve --daemon`) and the
// DISABLED path, where the tray is the only thing that starts — it is the one
// surface that can turn the dashboard back on, so it outlives the switch.
import { spawn } from "node:child_process";
import { writeFileSync, renameSync, appendFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { pidPath, ensureShim } from "./daemon.mjs";
import { renderTrayIconPng } from "./icon.mjs";

export async function launchTray({ home, port, shimPath = join(home, "serve.mjs"), tray = true, disabled = false, nodeExe = process.execPath, platform = process.platform, env = process.env } = {}) {
  if (platform !== "win32" || tray === false) return { ok: true, skipped: true };
  try {
    // Every tray command runs through the shim, so a path to a file nobody wrote
    // gives a menu whose Enable exits "Cannot find module" and reports nothing. The
    // disable path reaches here without one; writing it here covers every caller.
    ensureShim({ home, resolverSrc: fileURLToPath(new URL("../../statusline/resolver.mjs", import.meta.url)) });
    const iconPath = join(home, "dashboard-icon.png");
    writeFileSync(`${iconPath}.tmp`, renderTrayIconPng());
    renameSync(`${iconPath}.tmp`, iconPath);
    const trayScript = fileURLToPath(new URL("./tray.ps1", import.meta.url));
    // The tray needs a console — powershell.exe's WinForms loop dies without one — and
    // must outlive the parent that spawned it: `cmd /c start` gives it a fresh hidden
    // console AND breaks it out of our job.
    // `-Disabled` is a bare switch, absent rather than "false" when the dashboard is on;
    // daemon.test.mjs reads this literal to check each flag against the tray's params.
    const trayArgs = ["/c", "start", "", "/min", "powershell.exe", "-WindowStyle", "Hidden", "-NonInteractive",
      "-File", trayScript, "-PidFile", pidPath(home), "-NodeExe", nodeExe, "-ShimPath", shimPath,
      "-Port", String(port), "-IconPath", iconPath, "-SwarmHome", home,
      ...(disabled ? ["-Disabled"] : [])];
    // Test-only seam. Under `node --test` the tray is NEVER spawned for real: a live
    // NotifyIcon would land on the operator's desktop on every suite run, and the
    // process holds a handle inside the fixture's home — its own icon and guard file —
    // so the test's cleanup dies with EPERM on that directory. SWARM_SERVE_TEST_TRAY is
    // the optional recorder the row reads the argv back from.
    if (env.NODE_TEST_CONTEXT) {
      if (env.SWARM_SERVE_TEST_TRAY) {
        appendFileSync(env.SWARM_SERVE_TEST_TRAY, `${JSON.stringify({ argv: trayArgs })}\n`);
        return { ok: true, recorded: true };
      }
      return { ok: true, skipped: true };
    }
    const child = spawn("cmd.exe", trayArgs, { detached: true, stdio: "ignore", windowsHide: true });
    child.unref();
    return { ok: true };
  } catch (e) { return { ok: false, reason: `tray not started: ${e.message}` }; }
}
