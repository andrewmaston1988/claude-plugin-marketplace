// Fire-and-forget notification hook (e.g. "claude-slack notify --message {status}").
// Mechanical plumbing only: substitute tokens, spawn detached, swallow errors.
// Shared by the end-of-run status and the scheduler's single-shot cost warn.

/** The options every notify spawn uses. Named so a test can assert on them. */
export const NOTIFY_SPAWN_OPTIONS = {
  shell: true,
  detached: true,
  stdio: "ignore",
  // detached on Windows gives the child its own console, so every notifyCmd flashed a
  // shell window on each run. The daemon and tray spawns already hide theirs.
  windowsHide: true,
};

/** Substitute the three tokens a notifyCmd may carry. */
export function notifyCommandLine(notifyCmd, status, { digest = "", summary = "" } = {}) {
  return notifyCmd
    .replaceAll("{status}", status)
    .replaceAll("{digest}", digest)
    .replaceAll("{summary}", summary);
}

export function createNotifier({ notifyCmd, _spawn }) {
  return async (status, tokens = {}) => {
    if (!notifyCmd) return;
    const cmdLine = notifyCommandLine(notifyCmd, status, tokens);
    try {
      const spawn = _spawn ?? (await import("node:child_process")).spawn;
      spawn(cmdLine, { ...NOTIFY_SPAWN_OPTIONS }).unref();
    } catch { /* notification is garnish, never a failure */ }
  };
}
