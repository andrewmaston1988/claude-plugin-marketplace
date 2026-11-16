// Browsers ui-probe launches can outlive the probe: on Windows the spawned PID is a
// launcher stub, so when the owning node dies there is no parent link left to end
// them. This module is the backstop. It finds browsers whose profile is ours, judges
// ownership from a per-profile owner file, and stops the orphans in one batched call.

import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import { readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const execFileAsync = promisify(execFileCallback);

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
const MAX_BUFFER = 4 * 1024 * 1024;
// Stop-Process returns before the process is gone, and a browser root takes its children with it.
const KILL_SETTLE_TRIES = 5;
const KILL_SETTLE_MS = 100;

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

// Async on purpose: launch() caps the reap with a timer on this same event loop, and a
// synchronous spawn would block that timer for as long as the child ran.
async function runPowerShell(script, { _execFile = execFileAsync, timeoutMs = REAP_BUDGET_MS } = {}) {
  const args = ["-NoProfile", "-NonInteractive", "-Command", script];
  const options = { encoding: "utf8", windowsHide: true, timeout: timeoutMs, maxBuffer: MAX_BUFFER };
  let last;
  for (const exe of ["pwsh", "powershell"]) {
    try {
      const { stdout } = await _execFile(exe, args, options);
      return stdout ?? "";
    } catch (error) {
      if (error?.code === "ENOENT") {
        last = error;
        continue;
      }
      if (typeof error?.code === "number") throw new Error(`${exe} exited ${error.code}`);
      throw error;
    }
  }
  throw last ?? new Error("no PowerShell host available");
}

function parseCimProcesses(stdout) {
  // ConvertTo-Json leaves control characters in a command line unescaped, and JSON forbids
  // them inside a string. Any process carrying one would otherwise make every listing
  // unreadable, so the reaper would never run again on that machine.
  const text = String(stdout ?? "").replace(/[\u0000-\u001f]+/g, " ");
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
export async function listProcessesWindows({ _execFile = execFileAsync, timeoutMs = LOCK_TIMEOUT_MS } = {}) {
  const stdout = await runPowerShell(
    "Get-CimInstance Win32_Process " +
      "| Where-Object { $_.CommandLine -like '*ui-probe-profile-*' } " +
      "| Select-Object ProcessId,CommandLine | ConvertTo-Json -Compress",
    { _execFile, timeoutMs },
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

export async function listProcessesPosix({ _execFile = execFileAsync, timeoutMs = LOCK_TIMEOUT_MS } = {}) {
  const { stdout } = await _execFile("ps", ["-eo", "pid,args"], {
    encoding: "utf8",
    windowsHide: true,
    timeout: timeoutMs,
    maxBuffer: MAX_BUFFER,
  });
  return parsePsProcesses(stdout ?? "");
}

export function listProcesses({ platform = process.platform, ...options } = {}) {
  return platform === "win32" ? listProcessesWindows(options) : listProcessesPosix(options);
}

/** Creation time of `pid` in epoch ms, or null when the OS cannot say. Never guess:
 *  a null here is what keeps a live browser safe from a reused-PID verdict. */
export async function queryProcessStart(pid, {
  platform = process.platform,
  _execFile = execFileAsync,
  timeoutMs = PROCESS_QUERY_TIMEOUT_MS,
} = {}) {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  if (platform === "win32") {
    try {
      const stdout = await runPowerShell(
        `Get-CimInstance Win32_Process -Filter "ProcessId=${pid}" ` +
          "| ForEach-Object { $_.CreationDate.ToUniversalTime().ToString('o') }",
        { _execFile, timeoutMs },
      );
      return parseStartTime(stdout);
    } catch {
      return null;
    }
  }
  try {
    const options = { encoding: "utf8", windowsHide: true, timeout: timeoutMs };
    return parseStartTime((await _execFile("ps", ["-o", "lstart=", "-p", String(pid)], options)).stdout);
  } catch {
    return null;
  }
}

function parseStartTime(text) {
  const value = String(text ?? "").trim();
  if (!value) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

// --- killing ------------------------------------------------------------------

function parseIds(text) {
  return String(text ?? "")
    .split(/[\s,]+/)
    .map((part) => Number(part))
    .filter((pid) => Number.isInteger(pid) && pid > 0);
}

// One invocation, and it reads the survivors back: Stop-Process exits 0 even for a process it
// could not stop, so the exit code alone would report kills that never happened.
function stopScript(ids) {
  return `$ids = @(${ids.join(",")}); Stop-Process -Id $ids -Force -ErrorAction SilentlyContinue; ` +
    `$alive = @(); for ($i = 0; $i -lt ${KILL_SETTLE_TRIES}; $i++) { ` +
    "$alive = @($ids | Where-Object { Get-Process -Id $_ -ErrorAction SilentlyContinue } | ForEach-Object { $_.Id }); " +
    `if ($alive.Count -eq 0) { break }; Start-Sleep -Milliseconds ${KILL_SETTLE_MS} }; $alive -join ','`;
}

/** One batched stop per platform: N orphans must not cost N process launches. Only PIDs the
 *  call verified gone are reported killed; a survivor keeps its profile folder. */
export async function killPids(pids, { platform = process.platform, _execFile = execFileAsync, _kill = process.kill, _alive = pidAlive, timeoutMs = LOCK_TIMEOUT_MS } = {}) {
  const ids = [...new Set((pids ?? []).filter((pid) => Number.isInteger(pid) && pid > 0))];
  if (ids.length === 0) return { killed: [], failed: [] };
  const split = (survivors) => ({
    killed: ids.filter((pid) => !survivors.has(pid)),
    failed: ids.filter((pid) => survivors.has(pid)),
  });
  if (platform === "win32") {
    try {
      const wanted = new Set(ids);
      const stdout = await runPowerShell(stopScript(ids), { _execFile, timeoutMs });
      return split(new Set(parseIds(stdout).filter((pid) => wanted.has(pid))));
    } catch {
      // Unverified is not killed: claim nothing and let the next reap retry.
      return { killed: [], failed: ids };
    }
  }
  for (const pid of ids) {
    try { _kill(pid, "SIGKILL"); } catch { /* already gone: the survivor check is the verdict */ }
  }
  return split(new Set(ids.filter((pid) => _alive(pid))));
}

/** Stop the browser holding exactly `profile`. Best effort: the caller is already
 *  failing for another reason, and the next launch's reaper is the backstop. */
export async function killBrowserForProfile(profile, { _list = listProcesses, _kill = killPids, platform = process.platform, timeoutMs = REAP_BUDGET_MS, _execFile = execFileAsync } = {}) {
  const target = foldPath(profile, platform);
  let processes;
  try {
    processes = await _list({ platform, timeoutMs, _execFile });
  } catch {
    return { killed: [], failed: [] };
  }
  const pids = [];
  for (const entry of Array.isArray(processes) ? processes : []) {
    if (!entry || !Number.isInteger(entry.pid)) continue;
    const commandLine = String(entry.cmd ?? "");
    if (!BROWSER_NAME.test(commandLine) || commandLine.includes("--type=")) continue;
    const found = profileFromCommandLine(commandLine);
    if (found && foldPath(found, platform) === target) pids.push(entry.pid);
  }
  if (pids.length === 0) return { killed: [], failed: [] };
  try {
    return await _kill(pids, { platform, timeoutMs, _execFile });
  } catch {
    return { killed: [], failed: pids };
  }
}

// --- ownership verdicts -------------------------------------------------------

async function ownerStillAlive(owner, {
  isAlive,
  queryStart,
  toleranceMs,
  selfPid = process.pid,
  selfStartMs = ownerStartMs(),
}) {
  if (!owner) return false;
  if (!isAlive(owner.pid)) return false;
  // Our own pid needs no process spawn: the owner file we wrote carries the start time we
  // already know, and a launch that runs twice would otherwise pay a lister for its own profile.
  if (owner.pid === selfPid) return Math.abs(selfStartMs - owner.startMs) <= toleranceMs;
  const start = await queryStart(owner.pid);
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

async function candidateVerdict(candidate, {
  fs,
  now,
  graceMs,
  toleranceMs,
  isAlive,
  queryStart,
  selfPid,
  selfStartMs,
}) {
  const owner = readOwnerFile(candidate.profile, { fs });
  if (owner) {
    const alive = await ownerStillAlive(owner, { isAlive, queryStart, toleranceMs, selfPid, selfStartMs });
    return alive ? "live" : "orphan";
  }
  const browserStart = await queryStart(candidate.pid);
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
export async function preScanProfiles({
  fs = DEFAULT_FS,
  now = Date.now,
  tmpDir = tmpdir(),
  graceMs = PROFILE_GRACE_MS,
  toleranceMs = START_TOLERANCE_MS,
  isAlive = pidAlive,
  queryStart = queryProcessStart,
  selfPid = process.pid,
  selfStartMs = ownerStartMs(),
} = {}) {
  const profiles = listProfileDirs(fs, tmpDir);
  if (!profiles) return { skip: false, reason: "unreadable" };
  for (const profile of profiles) {
    const owner = readOwnerFile(profile.path, { fs });
    const alive = await ownerStillAlive(owner, { isAlive, queryStart, toleranceMs, selfPid, selfStartMs });
    if (!alive) return { skip: false, reason: owner ? "owner-gone" : "no-owner" };
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

  const prescan = await preScanProfiles({ fs, now, tmpDir, graceMs, toleranceMs, isAlive, queryStart });
  if (prescan.skip) {
    return { skipped: "prescan", killed: [], failed: [], swept: [], elapsedMs: now() - started };
  }

  let processes;
  try {
    processes = await list({ platform, timeoutMs });
  } catch {
    return { skipped: "listing-failed", killed: [], failed: [], swept: [], elapsedMs: now() - started };
  }
  if (!Array.isArray(processes)) {
    return { skipped: "listing-failed", killed: [], failed: [], swept: [], elapsedMs: now() - started };
  }

  const candidates = [];
  for (const entry of processes) {
    const candidate = candidateFromProcess(entry, { tmpDir, platform });
    if (candidate) candidates.push(candidate);
  }

  const orphans = [];
  for (const candidate of candidates) {
    const verdict = await candidateVerdict(candidate, {
      fs,
      now: now(),
      graceMs,
      toleranceMs,
      isAlive,
      queryStart,
    });
    if (verdict === "orphan") orphans.push(candidate.pid);
  }

  let killed = [];
  let failed = [];
  if (orphans.length > 0) {
    try {
      const result = await kill(orphans, { platform, timeoutMs });
      killed = Array.isArray(result?.killed) ? result.killed : [];
      failed = Array.isArray(result?.failed) ? result.failed : orphans.filter((pid) => !killed.includes(pid));
    } catch {
      // Best effort: a failed kill must not fail the launch. The next reap retries.
      failed = orphans;
    }
  }

  const stopped = new Set(killed);
  const liveProfiles = candidates.filter((candidate) => !stopped.has(candidate.pid)).map((c) => c.profile);
  const swept = sweepProfiles({ fs, now, tmpDir, platform, graceMs, liveProfiles }).removed;
  return { skipped: null, killed, failed, swept, elapsedMs: now() - started };
}
