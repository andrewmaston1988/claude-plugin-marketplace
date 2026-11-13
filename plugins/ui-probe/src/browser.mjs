import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect, sleep } from "./cdp.mjs";

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
const PORT_POLLS = 200;

const CLOSE_POLL_MS = 150;
const CLOSE_POLLS = 40;
const CLOSE_CALL_TIMEOUT_MS = 5000;
const PROFILE_REMOVE_TRIES = 5;
const PROFILE_REMOVE_RETRY_MS = 200;

export function findBrowser({ browser, _exists = existsSync, _spawnSync = spawnSync } = {}) {
  if (browser) {
    if (_exists(browser)) return browser;
    throw new Error(`browser not found: ${browser} (check the "browser" path in .ui-probe.json)`);
  }
  for (const candidate of CANDIDATES[process.platform] || []) {
    if (_exists(candidate)) return candidate;
  }
  const command = process.platform === "win32" ? "where" : "which";
  for (const name of PATH_NAMES) {
    const result = _spawnSync(command, [name], { encoding: "utf8" });
    const first = (result.stdout || "").split(/\r?\n/).map((line) => line.trim()).filter(Boolean)[0];
    if (first && _exists(first)) return first;
  }
  throw new Error("no Chromium browser found — install Edge, Chrome or Brave, or set \"browser\" in .ui-probe.json");
}

async function devtoolsPort(profile, child, { _fs, _sleep }) {
  const file = join(profile, "DevToolsActivePort");
  const started = Date.now();
  for (let i = 0; i < PORT_POLLS; i++) {
    if (_fs.existsSync(file)) {
      const port = Number(_fs.readFileSync(file, "utf8").split("\n")[0]);
      if (port) return port;
    }
    if (child.exitCode != null && Date.now() - started > LAUNCHER_GRACE_MS) {
      throw new Error(`browser exited early (code ${child.exitCode})`);
    }
    await _sleep(PORT_POLL_MS);
  }
  throw new Error("browser never wrote DevToolsActivePort");
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
} = {}) {
  const exe = findBrowser({ browser, _exists: _fs.existsSync, _spawnSync });
  const profile = _fs.mkdtempSync(join(tmpdir(), "ui-probe-profile-"));

  const args = [
    "--headless=new", "--remote-debugging-port=0", `--user-data-dir=${profile}`,
    "--no-first-run", "--no-default-browser-check", "--disable-extensions", "--disable-gpu",
    "--disable-background-networking", "--disable-sync",
  ];
  if (viewport) args.push(`--window-size=${viewport.width},${viewport.height}`);
  args.push("about:blank");

  const child = _spawn(exe, args, { stdio: "ignore" });
  const port = await devtoolsPort(profile, child, { _fs, _sleep });
  const versionUrl = `http://127.0.0.1:${port}/json/version`;
  const version = await (await _fetch(versionUrl)).json();
  const browserWs = await connect(version.webSocketDebuggerUrl, { _WebSocket, timeoutMs: CLOSE_CALL_TIMEOUT_MS });

  return {
    port,
    browserWs,
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
      if (!dead) console.warn(`ui-probe: browser on port ${port} still answering after Browser.close`);
      let removed = false;
      for (let i = 0; i < PROFILE_REMOVE_TRIES; i++) {
        try {
          _fs.rmSync(profile, { recursive: true, force: true });
          removed = true;
          break;
        } catch {
          await _sleep(PROFILE_REMOVE_RETRY_MS);
        }
      }
      if (!removed) console.warn(`ui-probe: could not remove the browser profile at ${profile}`);
    },
  };
}
