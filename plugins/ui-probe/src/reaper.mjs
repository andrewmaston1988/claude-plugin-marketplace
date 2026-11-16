// Browsers ui-probe launches can outlive the probe: on Windows the spawned PID is a
// launcher stub, so when the owning node dies there is no parent link left to end
// them. This module is the backstop. It finds browsers whose profile is ours, judges
// ownership from a per-profile owner file, and stops the orphans in one batched call.

import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

export const PROFILE_PREFIX = "ui-probe-profile-";
export const OWNER_FILE = "ui-probe.owner";
// A pre-change browser has no owner file, so only its age separates a live probe
// from an abandoned one. A day-old orphan is worth no extra safety margin.
export const PROFILE_GRACE_MS = 60 * 60 * 1000;
// Two reads of the same clock drift; the gap that means "another process reused
// the PID" is far larger than that.
export const START_TOLERANCE_MS = 2000;
export const REAP_BUDGET_MS = 5000;

const PROCESS_QUERY_TIMEOUT_MS = 3000;
const LOCK_TIMEOUT_MS = 5000;

const DEFAULT_FS = { readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync };
const BROWSER_NAME = /\b(?:msedge|chrome|chromium|brave)(?:\.exe)?\b/i;
const USER_DATA_DIR = /(?:^|[\s"])--user-data-dir=(?:"([^"]*)"|'([^']*)'|(\S+))/;

// --- owner file ---------------------------------------------------------------

/** Epoch ms this process started, from its own uptime. */
export function ownerStartMs(now = Date.now(), uptimeSec = process.uptime()) {
  return now - Math.round(uptimeSec * 1000);
}

/** Write `{ pid, startMs }` atomically: a crash leaves no file, never a torn one. */
export function writeOwnerFile(profile, { pid = process.pid, startMs = ownerStartMs(), fs = DEFAULT_FS } = {}) {
  const file = join(profile, OWNER_FILE);
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ pid, startMs }));
  fs.renameSync(tmp, file);
  return file;
}

/** The recorded owner, or null when it is missing or unusable. */
export function readOwnerFile(profile, { fs = DEFAULT_FS } = {}) {
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(join(profile, OWNER_FILE), "utf8"));
  } catch {
    return null;
  }
  if (!parsed || !Number.isInteger(parsed.pid) || parsed.pid <= 0 || !Number.isFinite(parsed.startMs)) {
    return null;
  }
  return { pid: parsed.pid, startMs: parsed.startMs };
}

/** A PID that exists but belongs to another user is still alive. */
export function pidAlive(pid, { _kill = process.kill } = {}) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    _kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
}

// --- command line and paths ---------------------------------------------------

/** The `--user-data-dir` value from a browser command line, quotes handled. */
export function profileFromCommandLine(commandLine) {
  const match = USER_DATA_DIR.exec(String(commandLine ?? ""));
  if (!match) return null;
  return match[1] ?? match[2] ?? match[3] ?? null;
}

function foldPath(path, platform) {
  const absolute = resolve(String(path)).replace(/\\/g, "/").replace(/\/+$/, "");
  return platform === "win32" ? absolute.toLowerCase() : absolute;
}

/** True only for a folder this plugin minted: a direct child of `tmpDir`, named
 *  with our prefix. A path that resolves out of `tmpDir` is never ours. */
export function isUiProbeProfile(profile, { tmpDir = tmpdir(), platform = process.platform } = {}) {
  if (typeof profile !== "string" || profile === "") return false;
  const root = foldPath(tmpDir, platform);
  const full = foldPath(profile, platform);
  if (!full.startsWith(`${root}/`)) return false;
  const name = full.slice(root.length + 1);
  return !name.includes("/") && name.startsWith(PROFILE_PREFIX);
}

// --- process listing ----------------------------------------------------------

function runPowerShell(script, { _spawnSync = spawnSync, timeoutMs = REAP_BUDGET_MS, capture = true } = {}) {
  const args = ["-NoProfile", "-NonInteractive", "-Command", script];
  const options = capture
    ? { encoding: "utf8", windowsHide: true, timeout: timeoutMs }
    : { stdio: "ignore", windowsHide: true, timeout: timeoutMs };
  let last;
  for (const exe of ["pwsh", "powershell"]) {
    const result = _spawnSync(exe, args, options);
    if (result?.error?.code === "ENOENT") {
      last = result.error;
      continue;
    }
    if (result?.error) throw result.error;
    if (result?.status !== 0) throw new Error(`${exe} exited ${result?.status ?? "unknown"}`);
    return result.stdout ?? "";
  }
  throw last ?? new Error("no PowerShell host available");
}

function parseCimProcesses(stdout) {
  const text = String(stdout ?? "");
  if (!text.trim()) return []; // a successful empty listing licenses the sweep
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error("could not parse the process listing");
  }
  const rows = Array.isArray(parsed) ? parsed : [parsed];
  const processes = [];
  for (const row of rows) {
    if (!row || !Number.isInteger(row.ProcessId)) continue;
    processes.push({ pid: row.ProcessId, cmd: String(row.CommandLine ?? "") });
  }
  if (rows.length > 0 && processes.length === 0) throw new Error("could not parse the process listing");
  return processes;
}

/** Browser candidates only: server-side filter keeps the JSON small on a busy host. */
export function listProcessesWindows({ _spawnSync = spawnSync, timeoutMs = LOCK_TIMEOUT_MS } = {}) {
  const stdout = runPowerShell(
    "Get-CimInstance Win32_Process " +
      "| Where-Object { $_.CommandLine -like '*ui-probe-profile-*' } " +
      "| Select-Object ProcessId,CommandLine | ConvertTo-Json -Compress",
    { _spawnSync, timeoutMs },
  );
  return parseCimProcesses(stdout);
}

function parsePsProcesses(stdout) {
  const processes = [];
  let headerSeen = false;
  for (const line of String(stdout ?? "").split(/\r?\n/)) {
    if (!line.trim()) continue;
    if (!headerSeen && /^\s*PID\b/i.test(line)) {
      headerSeen = true;
      continue;
    }
    const match = /^\s*(\d+)\s+(.+)$/.exec(line);
    if (!match) throw new Error("could not parse the process listing");
    processes.push({ pid: Number(match[1]), cmd: match[2] });
  }
  return processes;
}

export function listProcessesPosix({ _spawnSync = spawnSync, timeoutMs = LOCK_TIMEOUT_MS } = {}) {
  const result = _spawnSync("ps", ["-eo", "pid,args"], {
    encoding: "utf8",
    windowsHide: true,
    timeout: timeoutMs,
  });
  if (result?.error) throw result.error;
  if (result?.status !== 0) throw new Error(`ps exited ${result?.status ?? "unknown"}`);
  return parsePsProcesses(result.stdout ?? "");
}

export function listProcesses({ platform = process.platform, ...options } = {}) {
  return platform === "win32" ? listProcessesWindows(options) : listProcessesPosix(options);
}

/** Creation time of `pid` in epoch ms, or null when the OS cannot say. Never guess:
 *  a null here is what keeps a live browser safe from a reused-PID verdict. */
export function queryProcessStart(pid, {
  platform = process.platform,
  _spawnSync = spawnSync,
  timeoutMs = PROCESS_QUERY_TIMEOUT_MS,
} = {}) {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  if (platform === "win32") {
    let stdout;
    try {
      stdout = runPowerShell(
        `Get-CimInstance Win32_Process -Filter "ProcessId=${pid}" ` +
          "| ForEach-Object { $_.CreationDate.ToUniversalTime().ToString('o') }",
        { _spawnSync, timeoutMs },
      );
    } catch {
      return null;
    }
    return parseStartTime(stdout);
  }
  const result = _spawnSync("ps", ["-o", "lstart=", "-p", String(pid)], {
    encoding: "utf8",
    windowsHide: true,
    timeout: timeoutMs,
  });
  if (result?.error || result?.status !== 0) return null;
  return parseStartTime(result.stdout);
}

function parseStartTime(text) {
  const value = String(text ?? "").trim();
  if (!value) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

// --- killing ------------------------------------------------------------------

/** One batched stop per platform: N orphans must not cost N process launches. */
export function killPids(pids, {
  platform = process.platform,
  _spawnSync = spawnSync,
  _kill = process.kill,
  timeoutMs = LOCK_TIMEOUT_MS,
} = {}) {
  const ids = [...new Set((pids ?? []).filter((pid) => Number.isInteger(pid) && pid > 0))];
  if (ids.length === 0) return { killed: [] };
  if (platform === "win32") {
    // Validated integers cannot inject into the script; -Id takes the whole list.
    runPowerShell(`Stop-Process -Id ${ids.join(",")} -Force -ErrorAction SilentlyContinue`, {
      _spawnSync,
      timeoutMs,
      capture: false,
    });
    return { killed: ids };
  }
  for (const pid of ids) {
    try {
      _kill(pid, "SIGKILL");
    } catch {
      // Already gone: nothing to report.
    }
  }
  return { killed: ids };
}

/** Stop the browser holding exactly `profile`. Best effort: the caller is already
 *  failing for another reason, and the next launch's reaper is the backstop. */
export async function killBrowserForProfile(profile, {
  _list = listProcesses,
  _kill = killPids,
  platform = process.platform,
  timeoutMs = REAP_BUDGET_MS,
  _spawnSync = spawnSync,
} = {}) {
  const target = foldPath(profile, platform);
  let processes;
  try {
    processes = await _list({ platform, timeoutMs, _spawnSync });
  } catch {
    return { killed: [] };
  }
  const pids = [];
  for (const entry of Array.isArray(processes) ? processes : []) {
    if (!entry || !Number.isInteger(entry.pid)) continue;
    const commandLine = String(entry.cmd ?? "");
    if (!BROWSER_NAME.test(commandLine) || commandLine.includes("--type=")) continue;
    const found = profileFromCommandLine(commandLine);
    if (found && foldPath(found, platform) === target) pids.push(entry.pid);
  }
  if (pids.length === 0) return { killed: [] };
  try {
    return await _kill(pids, { platform, timeoutMs, _spawnSync });
  } catch {
    return { killed: [] };
  }
}

// --- ownership verdicts -------------------------------------------------------

function ownerStillAlive(owner, { isAlive, queryStart, toleranceMs }) {
  if (!owner) return false;
  if (!isAlive(owner.pid)) return false;
  const start = queryStart(owner.pid);
  if (start == null) return true; // unknown start: a live PID is not grounds to kill
  return Math.abs(start - owner.startMs) <= toleranceMs;
}

function candidateFromProcess(entry, { tmpDir, platform }) {
  if (!entry || !Number.isInteger(entry.pid) || entry.pid <= 0) return null;
  const commandLine = String(entry.cmd ?? "");
  if (!BROWSER_NAME.test(commandLine)) return null;
  // Renderer and GPU children carry --type=; stopping the root takes them with it.
  if (commandLine.includes("--type=")) return null;
  const profile = profileFromCommandLine(commandLine);
  if (!profile || !isUiProbeProfile(profile, { tmpDir, platform })) return null;
  return { pid: entry.pid, profile };
}

function candidateVerdict(candidate, { fs, now, graceMs, toleranceMs, isAlive, queryStart }) {
  const owner = readOwnerFile(candidate.profile, { fs });
  if (owner) {
    if (!ownerStillAlive(owner, { isAlive, queryStart, toleranceMs })) return "orphan";
    return "live";
  }
  const browserStart = queryStart(candidate.pid);
  if (browserStart == null) return "unknown";
  return now - browserStart > graceMs ? "orphan" : "young";
}

function listProfileDirs(fs, tmpDir) {
  let entries;
  try {
    entries = fs.readdirSync(tmpDir, { withFileTypes: true });
  } catch {
    return null;
  }
  const dirs = [];
  for (const entry of entries) {
    const name = String(entry?.name ?? entry);
    if (!name.startsWith(PROFILE_PREFIX)) continue;
    if (entry && typeof entry.isDirectory === "function" && !entry.isDirectory()) continue;
    const path = join(tmpDir, name);
    try {
      dirs.push({ path, mtimeMs: fs.statSync(path).mtimeMs });
    } catch {
      return null; // one vanished folder: staleness is unknowable, so let the lister run
    }
  }
  return dirs;
}

/** The pre-scan that keeps a clean machine from paying for a process listing.
 *  Skipping is only sound when nothing could be acted on: every owner alive and
 *  every folder still inside the grace. */
export function preScanProfiles({
  fs = DEFAULT_FS,
  now = Date.now,
  tmpDir = tmpdir(),
  graceMs = PROFILE_GRACE_MS,
  toleranceMs = START_TOLERANCE_MS,
  isAlive = pidAlive,
  queryStart = queryProcessStart,
} = {}) {
  const profiles = listProfileDirs(fs, tmpDir);
  if (!profiles) return { skip: false, reason: "unreadable" };
  for (const profile of profiles) {
    const owner = readOwnerFile(profile.path, { fs });
    if (!ownerStillAlive(owner, { isAlive, queryStart, toleranceMs })) {
      return { skip: false, reason: owner ? "owner-gone" : "no-owner" };
    }
    if (now() - profile.mtimeMs > graceMs) return { skip: false, reason: "stale" };
  }
  return { skip: true, reason: profiles.length === 0 ? "clean" : "owned" };
}

/** Remove old profile folders no live browser holds. A failed removal keeps the
 *  folder for the next sweep rather than failing the launch. */
export function sweepProfiles({
  fs = DEFAULT_FS,
  now = Date.now,
  tmpDir = tmpdir(),
  platform = process.platform,
  graceMs = PROFILE_GRACE_MS,
  liveProfiles = [],
} = {}) {
  const held = new Set(liveProfiles.map((profile) => foldPath(profile, platform)));
  const profiles = listProfileDirs(fs, tmpDir) ?? [];
  const removed = [];
  const kept = [];
  const failed = [];
  for (const profile of profiles) {
    if (held.has(foldPath(profile.path, platform)) || now() - profile.mtimeMs <= graceMs) {
      kept.push(profile.path);
      continue;
    }
    try {
      fs.rmSync(profile.path, { recursive: true, force: true });
      removed.push(profile.path);
    } catch {
      failed.push(profile.path);
    }
  }
  return { removed, kept, failed };
}

// --- the reaper ---------------------------------------------------------------

/** Stop every browser we launched whose owner is gone, then sweep stale profiles.
 *
 *  A listing that failed is not an empty listing: without it a held profile and an
 *  abandoned one look identical, so neither the kill nor the sweep runs. */
export async function reapOrphans({
  listProcesses: list = listProcesses,
  kill = killPids,
  queryStart = queryProcessStart,
  isAlive = pidAlive,
  fs = DEFAULT_FS,
  now = Date.now,
  tmpDir = tmpdir(),
  platform = process.platform,
  graceMs = PROFILE_GRACE_MS,
  toleranceMs = START_TOLERANCE_MS,
  timeoutMs = REAP_BUDGET_MS,
} = {}) {
  const started = now();

  const prescan = preScanProfiles({ fs, now, tmpDir, graceMs, toleranceMs, isAlive, queryStart });
  if (prescan.skip) {
    return { skipped: "prescan", killed: [], swept: [], elapsedMs: now() - started };
  }

  let processes;
  try {
    processes = await list({ platform, timeoutMs });
  } catch {
    return { skipped: "listing-failed", killed: [], swept: [], elapsedMs: now() - started };
  }
  if (!Array.isArray(processes)) {
    return { skipped: "listing-failed", killed: [], swept: [], elapsedMs: now() - started };
  }

  const candidates = [];
  for (const entry of processes) {
    const candidate = candidateFromProcess(entry, { tmpDir, platform });
    if (candidate) candidates.push(candidate);
  }

  const orphans = [];
  for (const candidate of candidates) {
    const verdict = candidateVerdict(candidate, { fs, now: now(), graceMs, toleranceMs, isAlive, queryStart });
    if (verdict === "orphan") orphans.push(candidate.pid);
  }

  let killed = [];
  if (orphans.length > 0) {
    try {
      const result = await kill(orphans, { platform, timeoutMs });
      killed = Array.isArray(result?.killed) ? result.killed : orphans;
    } catch {
      // Best effort: a failed kill must not fail the launch. The next reap retries.
    }
  }

  const stopped = new Set(killed);
  const liveProfiles = candidates.filter((candidate) => !stopped.has(candidate.pid)).map((c) => c.profile);
  const swept = sweepProfiles({ fs, now, tmpDir, platform, graceMs, liveProfiles }).removed;
  return { skipped: null, killed, swept, elapsedMs: now() - started };
}
