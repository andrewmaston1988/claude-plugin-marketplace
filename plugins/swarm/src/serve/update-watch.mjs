// The daemon's update watcher. `swarm serve` (foreground) arms this once it is
// listening: when the plugin registry moves off the version this daemon runs,
// hand the port to a replacement started through the stable shim, and exit only
// once that replacement is CONFIRMED listening. A replacement that fails to
// start never strands the dashboard — the caller's retake puts this daemon back
// on the port and it keeps serving the old version, logged.
//
// Every side effect is injected, per daemon.mjs's style: tests drive the
// registry events, the spawner and the clock, and nothing ever re-execs.
import { watch as fsWatch } from "node:fs";
import { basename, dirname } from "node:path";
import { spawn } from "node:child_process";
import { isStale, isAlive, waitForDaemon, resolveInstalled, readPid } from "./daemon.mjs";

// The re-exec argv: through the STABLE shim, never this plugin's sha-versioned
// cache dir — that dir moves on every update, and a launch path baked to it is
// precisely the stale install this watcher exists to cure. FOREGROUND `serve`,
// not `--daemon`: the replacement must not spawn a second tray, and on the
// takeover path it writes the pid record itself.
export const reExecArgv = (shimPath) => [process.execPath, shimPath, "scripts/swarm.mjs", "serve"];

const defaultSpawnReplacement = async (argv) => {
  try {
    const child = spawn(argv[0], argv.slice(1), { detached: true, stdio: "ignore", windowsHide: true });
    child.unref();
    return { ok: true, pid: child.pid };
  } catch (e) { return { ok: false, reason: e.message }; }
};

export function startUpdateWatch({
  registryPath, own, shimPath, home = null,
  autoRestart = true,
  debounceMs = 500, pollMs = 250, deadlineMs = 20000, slowPollMs = 5000,
  resolve = () => resolveInstalled({ registry: registryPath }),
  readRecord = () => readPid(home),
  prepare, spawnReplacement = defaultSpawnReplacement, confirm = null, retake,
  exit = () => process.exit(0), onStale = () => {}, log = () => {},
  watch = fsWatch,
  setTimeout: _setTimeout = (...a) => setTimeout(...a), clearTimeout: _clearTimeout = (...a) => clearTimeout(...a),
  now = Date.now,
}) {
  if (!prepare || !retake) throw new Error("startUpdateWatch: prepare and retake are required");
  const doConfirm = confirm || (() => waitForDaemon({
    read: readRecord, isAlive, excludePid: own.pid,
    failOnCleared: true, revertIsFailure: true,
    deadlineMs, pollMs, now, sleep: (ms) => new Promise((r) => _setTimeout(r, ms)),
  }));

  // The version this daemon has already dealt with. It moves after a failed
  // handover so one bad replacement is not a retry loop; a genuinely newer
  // version after it still triggers.
  let baseline = own.version ?? null;
  const reported = new Set(); // report-only mode: once per distinct version
  let debounceTimer = null, slowTimer = null, busy = false, done = false;

  const schedule = () => {
    if (debounceTimer) _clearTimeout(debounceTimer);
    debounceTimer = _setTimeout(() => { debounceTimer = null; check(); }, debounceMs);
  };

  const runCheck = async () => {
    if (busy || done) return;
    const installed = resolve();
    if (!isStale({ version: baseline }, installed)) return;
    if (!autoRestart) {
      // The key is the operator's off switch, not the watcher's: report the
      // mismatch (once per distinct version) so status, doctor and the tray
      // still show it, and never spawn.
      if (!reported.has(installed.version)) {
        reported.add(installed.version);
        log(`update available: running ${baseline}, installed ${installed.version} — dashboard.autoRestartOnUpdate is false; run: swarm serve restart`);
        onStale(installed);
      }
      return;
    }
    busy = true;
    try {
      log(`update detected: running ${baseline} → installed ${installed.version} — handing over`);
      // Release the port BEFORE spawning: a replacement that cannot bind dies
      // at listen and hands the record back, and a spawn-then-wait watcher
      // would sit here forever watching a handover that can never finish.
      await prepare();
      const res = await spawnReplacement(reExecArgv(shimPath));
      if (!res.ok) {
        log(`replacement failed to start (${res.reason}) — retaking the port`);
        await retake();
      } else {
        const c = await doConfirm();
        if (c.ok) {
          done = true;
          log(`replacement pid ${c.record.pid} is listening — exiting`);
          exit();
          return;
        }
        log(`replacement did not come up (${c.reason}) — retaking the port`);
        await retake();
      }
      baseline = installed.version;
    } catch (e) {
      log(`handover failed (${e?.message ?? e}) — retaking the port`);
      try { await retake(); } catch { /* port already gone; the next check decides */ }
      baseline = installed.version;
    } finally {
      busy = false;
      if (!done) schedule(); // an update that landed mid-handover fired no event of its own
    }
  };
  const check = async () => {
    try { await runCheck(); } catch (e) { log(`update check failed (${e?.message ?? e})`); }
  };

  let watcher = null;
  try {
    watcher = watch(dirname(registryPath), (event, filename) => {
      if (!filename || filename === basename(registryPath)) schedule();
    });
    watcher.on?.("error", (e) => log(`registry watcher error: ${e?.message ?? e}`));
  } catch (e) {
    log(`cannot watch ${dirname(registryPath)} (${e?.message ?? e}) — checking every ${slowPollMs}ms instead`);
  }
  if (!watcher) {
    const poll = () => { slowTimer = _setTimeout(() => { check(); poll(); }, slowPollMs); };
    poll();
  }

  return {
    stop: () => {
      done = true;
      if (debounceTimer) { _clearTimeout(debounceTimer); debounceTimer = null; }
      if (slowTimer) { _clearTimeout(slowTimer); slowTimer = null; }
      watcher?.close?.();
    },
  };
}