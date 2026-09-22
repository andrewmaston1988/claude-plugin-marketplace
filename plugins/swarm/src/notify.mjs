// Fire-and-forget notification hook (e.g. "claude-slack notify --message {status}").
// Mechanical plumbing only: substitute tokens, spawn detached, swallow errors.
// Shared by the end-of-run status and the scheduler's single-shot cost warn.
import { spawn as nodeSpawn } from "node:child_process";

/**
 * The options every non-Windows notify spawn uses. Named so a test can assert on them.
 * Windows does not use this path at all — see windowsLaunch below.
 */
export const NOTIFY_SPAWN_OPTIONS = {
  shell: true,
  detached: true,
  stdio: "ignore",
  windowsHide: true,
};

/**
 * Windows needs both halves of the tray's launch shape, and neither alone is enough:
 *
 *   survives the parent   hides the console
 *   -------------------   -----------------
 *   detached               no    (DETACHED_PROCESS means "inherit no console", so the
 *                                 child allocates its own and CREATE_NO_WINDOW is inert
 *                                 beside it — the reason windowsHide never worked here)
 *   no detached            yes, but the child dies with the run and never notifies
 *   cmd /c start           yes   no    (a fresh console, still shown)
 *   start + the target's own hidden-window flag   yes   yes
 *
 * So: `cmd.exe` by argv (never shell:true, which would put cmd's own console in the
 * way), `start` to get a fresh console that is not in our job, and the caller's
 * notifyCmd carrying its own hidden-window flag — `-WindowStyle Hidden` for a
 * PowerShell command. A notifyCmd without one still notifies; it just flashes.
 *
 * The notifyCmd goes to `start` as its own argv words, NOT re-wrapped in another
 * `cmd.exe /c`: that wrapper gets its own console, which is shown, and the target's
 * hidden-window flag then has nothing to hide. Measured — the wrapped form reports
 * a visible console; this one reports none.
 */
export function windowsLaunchArgs(cmdLine) {
  return ["/c", "start", "", "/min", ...splitCommand(cmdLine)];
}

/**
 * Split a command line into argv the way cmd does: double quotes group, everything
 * else splits on whitespace. Quotes are dropped, since each word is passed as its
 * own argument and never re-parsed by a shell.
 */
export function splitCommand(line) {
  return [...line.matchAll(/"([^"]*)"|(\S+)/g)].map((m) => m[1] ?? m[2]);
}

/** Substitute the three tokens a notifyCmd may carry. */
export function notifyCommandLine(notifyCmd, status, { digest = "", summary = "" } = {}) {
  return notifyCmd
    .replaceAll("{status}", status)
    .replaceAll("{digest}", digest)
    .replaceAll("{summary}", summary);
}

export function createNotifier({ notifyCmd, _spawn = nodeSpawn, _platform = process.platform }) {
  return async (status, tokens = {}) => {
    if (!notifyCmd) return;
    const cmdLine = notifyCommandLine(notifyCmd, status, tokens);
    try {
      const child = _platform === "win32"
        ? _spawn("cmd.exe", windowsLaunchArgs(cmdLine), { detached: true, stdio: "ignore", windowsHide: true })
        : _spawn(cmdLine, { ...NOTIFY_SPAWN_OPTIONS });
      child.unref();
    } catch { /* notification is garnish, never a failure */ }
  };
}
