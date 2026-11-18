import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { connect, sleep } from "./cdp.mjs";
import { PROFILE_PREFIX, REAP_BUDGET_MS, killBrowserForProfile, reapOrphans, writeOwnerFile } from "./reaper.mjs";
import { profilesDir } from "./temp-paths.mjs";

const CANDIDATES = {
  win32: [
    "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
    "C:/Program Files/Microsoft/Edge/Application/msedge.exe",
    "C:/Program Files/Google/Chrome/Application/chrome.exe",
    "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
    "C:/Program Files/BraveSoftware/Brave-Browser/Application/brave.exe",
  ],
  darwin: [
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
    "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
  ],
};

const PATH_NAMES = [
  "chrome", "google-chrome", "google-chrome-stable", "chromium", "chromium-browser",
  "microsoft-edge", "brave-browser",
];

const DEFAULT_FS = { mkdtempSync, existsSync, readFileSync, rmSync };

// On Windows chrome.exe is a launcher stub: it hands the profile to the real browser and exits 0
// within milliseconds, so an early exit is fatal only when no DevToolsActivePort appears.
const LAUNCHER_GRACE_MS = 8000;
const PORT_POLL_MS = 100;
// Generous on purpose: a cold start on a busy machine can take a minute; a healthy one returns early.
const PORT_POLLS = 600;

const CLOSE_POLL_MS = 150;
const CLOSE_POLLS = 40;
const CLOSE_CALL_TIMEOUT_MS = 5000;
const PROFILE_REMOVE_TRIES = 5;
const PROFILE_REMOVE_RETRY_MS = 200;

export function findBrowser({
  browser,
  _exists = existsSync,
  _spawnSync = spawnSync,
  _platform = process.platform,
} = {}) {
  if (browser) {
    if (_exists(browser)) return browser;
    throw new Error(`browser not found: ${browser} (check the "browser" path in .ui-probe.json)`);
  }
  for (const candidate of CANDIDATES[_platform] || []) {
    if (_exists(candidate)) return candidate;
  }
  const command = _platform === "win32" ? "where" : "which";
  for (const name of PATH_NAMES) {
    const result = _spawnSync(command, [name], { encoding: "utf8" });
    const first = (result.stdout || "").split(/\r?\n/).map((line) => line.trim()).filter(Boolean)[0];
    if (first && _exists(first)) return first;
  }
  throw new Error("no Chromium browser found — install Edge, Chrome or Brave, or set \"browser\" in .ui-probe.json");
}

async function devtoolsPort(profile, child, { _fs, _sleep, _now = Date.now }) {
  const file = join(profile, "DevToolsActivePort");
  const started = _now();
  let lastReadError;
  const failure = (message) => {
    const detail = lastReadError?.code || lastReadError?.message;
    return new Error(detail ? `${message} (last read: ${detail})` : message);
  };
  for (let i = 0; i < PORT_POLLS; i++) {
    if (_fs.existsSync(file)) {
      try {
        const lines = _fs.readFileSync(file, "utf8").split(/\r?\n/);
        const port = Number(lines[0]);
        if (lines[1] && /^\d+$/.test(lines[0]) && port >= 1 && port <= 65535) return port;
      } catch (error) {
        lastReadError = error;
      }
    }
    if (child.exitCode != null && _now() - started > LAUNCHER_GRACE_MS) {
      throw failure(`browser exited early (code ${child.exitCode})`);
    }
    await _sleep(PORT_POLL_MS);
  }
  throw failure("browser never wrote DevToolsActivePort");
}

/** Best-effort reap. A lister that throws or overruns is the next launch's problem, not this
 *  one's, but the caller still gets a verdict so the failure is not silent. */
async function reapWithinBudget(_reap, budgetMs) {
  let timer;
  const overran = { overran: true };
  const reap = Promise.resolve().then(() => _reap()).catch((error) => ({ error }));
  try {
    const result = await Promise.race([
      reap,
      new Promise((resolve) => { timer = setTimeout(() => resolve(overran), budgetMs); }),
    ]);
    return result === overran ? overran : (result ?? {});
  } finally {
    clearTimeout(timer);
  }
}

/** One line for a reap that did something or could not run; a clean, empty reap says nothing. */
function logReap(result) {
  if (!result) return;
  if (result.error) {
    console.warn(`ui-probe: the reap failed (${result.error?.message ?? result.error})`);
    return;
  }
  if (result.overran) {
    console.warn(`ui-probe: the reap overran its ${REAP_BUDGET_MS} ms budget and continues in the background`);
    return;
  }
  const killed = result.killed?.length ?? 0;
  const failed = result.failed?.length ?? 0;
  const swept = result.swept?.length ?? 0;
  // "prescan" is the clean fast path, not a skip worth reporting.
  const skipped = result.skipped && result.skipped !== "prescan" ? result.skipped : null;
  const parts = [];
  if (killed) parts.push(`reaped ${killed} orphaned browser${killed === 1 ? "" : "s"}`);
  if (failed) parts.push(`could not stop ${failed} browser${failed === 1 ? "" : "s"}`);
  if (swept) parts.push(`swept ${swept} profile folder${swept === 1 ? "" : "s"}`);
  if (skipped) parts.push(`skipped (${skipped})`);
  if (parts.length > 0) console.warn(`ui-probe: ${parts.join("; ")}`);
}

/** A kill only licenses deleting the profile when the module could verify the browser gone. */
function killVerified(result) {
  return !result?.unverified && !result?.failed?.length;
}

/** Windows holds the profile open for a moment after the browser goes, so one rmdir is not enough. */
async function removeProfile(profile, { _fs, _sleep }) {
  for (let i = 0; i < PROFILE_REMOVE_TRIES; i++) {
    try {
      _fs.rmSync(profile, { recursive: true, force: true });
      return true;
    } catch {
      await _sleep(PROFILE_REMOVE_RETRY_MS);
    }
  }
  return false;
}

export async function launch({
  browser,
  viewport,
  _spawn = spawn,
  _fetch = fetch,
  _fs = DEFAULT_FS,
  _spawnSync = spawnSync,
  _WebSocket = WebSocket,
  _sleep = sleep,
  _now = Date.now,
  _reap = reapOrphans,
  _kill = killBrowserForProfile,
  _writeOwner = writeOwnerFile,
} = {}) {
  const exe = findBrowser({ browser, _exists: _fs.existsSync, _spawnSync });

  // Whatever an earlier run left behind goes before this one adds to it.
  logReap(await reapWithinBudget(_reap, REAP_BUDGET_MS));

  // The profiles root is created here, not through _fs: every injected fake is a read/delete
  // seam and none of them carries mkdirSync.
  const profiles = profilesDir();
  mkdirSync(profiles, { recursive: true });
  const profile = _fs.mkdtempSync(join(profiles, PROFILE_PREFIX));
  let browserWs = null;

  try {
    // The launcher stub leaves the real browser with no parent link, so the owner file is the
    // only thing that says this profile still has a live probe behind it.
    _writeOwner(profile);

    // --remote-debugging-pipe answered no CDP frame on Windows Edge while the browser was alive,
    // so the transport cannot own the browser's lifetime; the reaper is the backstop instead.
    const args = [
      "--headless=new", "--remote-debugging-port=0", `--user-data-dir=${profile}`,
      "--no-first-run", "--no-default-browser-check", "--disable-extensions", "--disable-gpu",
      "--disable-background-networking", "--disable-sync",
      // Headless Chromium reports hover:none/pointer:none with no mouse attached; this gives it one,
      // so touch emulation is what flips a page to coarse and turning it off restores fine.
      "--blink-settings=primaryHoverType=2,availableHoverTypes=2,primaryPointerType=4,availablePointerTypes=4",
    ];
    if (viewport) args.push(`--window-size=${viewport.width},${viewport.height}`);
    args.push("about:blank");

    const child = _spawn(exe, args, { stdio: "ignore" });
    const port = await devtoolsPort(profile, child, { _fs, _sleep, _now });
    const versionUrl = `http://127.0.0.1:${port}/json/version`;
    const version = await (await _fetch(versionUrl)).json();
    browserWs = await connect(version.webSocketDebuggerUrl, { _WebSocket, timeoutMs: CLOSE_CALL_TIMEOUT_MS });

    // The page hop belongs to the launch, not to each caller: a caller that has to know the
    // transport would break the moment the transport changes.
    let page = null;
    const attachPage = () => {
      page ??= connect(port, { _WebSocket, _fetch, _sleep });
      return page;
    };

    return {
      port,
      browserWs,
      profile,
      attachPage,
      // The spawned PID is the launcher stub, already exited, so the only handle on the real browser
      // is its socket: ask it to close, confirm the debugging port went quiet, then drop the profile.
      async close() {
        try { await browserWs.send("Browser.close"); } catch { /* the browser may already be gone */ }
        browserWs.close();
        let dead = false;
        for (let i = 0; i < CLOSE_POLLS; i++) {
          try {
            await _fetch(versionUrl, { signal: AbortSignal.timeout(300) });
          } catch {
            dead = true;
            break;
          }
          await _sleep(CLOSE_POLL_MS);
        }
        if (!dead) {
          console.warn(`ui-probe: browser on port ${port} still answering after Browser.close`);
          // It ignored the polite ask; the profile is the only handle left on it.
          try {
            dead = killVerified(await _kill(profile));
          } catch { /* unverified: the folder stays for the next reap */ }
        }
        // A profile folder is deleted only when the browser holding it is verified gone.
        if (dead) {
          if (!(await removeProfile(profile, { _fs, _sleep }))) {
            console.warn(`ui-probe: could not remove the browser profile at ${profile}`);
          }
        } else {
          console.warn(`ui-probe: kept the browser profile at ${profile}; the browser could not be verified gone`);
        }
      },
    };
  } catch (error) {
    // Whatever failed, the browser we spawned must not outlive this call.
    let gone = false;
    try {
      if (browserWs) browserWs.close();
      gone = killVerified(await _kill(profile));
    } catch { /* the rethrow below is the failure that matters */ }
    // An unverified kill keeps the folder: the next reap retries rather than orphaning a browser.
    if (gone && !(await removeProfile(profile, { _fs, _sleep }))) {
      console.warn(`ui-probe: could not remove the browser profile at ${profile}`);
    }
    throw error;
  }
}
