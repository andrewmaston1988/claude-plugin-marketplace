// Browsers ui-probe launches can outlive the probe: on Windows the spawned PID is a
// launcher stub, so when the owning node dies there is no parent link left to end
// them. This module is the backstop. It finds browsers whose profile is ours, judges
// ownership from a per-profile owner file, and stops the orphans in one batched call.

import { readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  REAP_BUDGET_MS,
  killPids,
  listProcesses,
  pidAlive,
  queryProcessStart,
  queryProcessStarts,
} from "./reaper-process.mjs";

// The OS seam stays reachable from this module: browser.mjs and the tests import one path.
export {
  REAP_BUDGET_MS,
  killPids,
  listProcesses,
  listProcessesPosix,
  listProcessesWindows,
  pidAlive,
  queryProcessStart,
  queryProcessStarts,
} from "./reaper-process.mjs";

export const PROFILE_PREFIX = "ui-probe-profile-";
export const OWNER_FILE = "ui-probe.owner";
// A pre-change browser has no owner file, so only its age separates a live probe
// from an abandoned one. A day-old orphan is worth no extra safety margin.
export const PROFILE_GRACE_MS = 60 * 60 * 1000;
// Two reads of the same clock drift; the gap that means "another process reused
// the PID" is far larger than that.
export const START_TOLERANCE_MS = 2000;

const DEFAULT_FS = { readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync };
const BROWSER_NAME = /\b(?:msedge|chrome|chromium|brave)(?:\.exe)?\b/i;
// Node quotes the whole argument when its value has a space ("--user-data-dir=C:\Bob Smith\…"),
// quotes only the value when a launcher does, and leaves it bare otherwise; `ps` joins argv
// with spaces, so there the value runs to the next flag.
const USER_DATA_DIR =
  /(?:^|\s)"--user-data-dir=([^"]*)"|(?:^|\s)--user-data-dir=(?:"([^"]*)"|'([^']*)'|(.*?)(?=\s--|$))/;

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

// --- command line and paths ---------------------------------------------------

/** The `--user-data-dir` value from a browser command line, quotes handled. */
export function profileFromCommandLine(commandLine) {
  const match = USER_DATA_DIR.exec(String(commandLine ?? ""));
  if (!match) return null;
  return match[1] ?? match[2] ?? match[3] ?? match[4] ?? null;
}

export function foldPath(path, platform = process.platform) {
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

/** Stop the browser holding exactly `profile`. Best effort: the caller is already
 *  failing for another reason, and the next launch's reaper is the backstop. */
export async function killBrowserForProfile(profile, { _list = listProcesses, _kill = killPids, platform = process.platform, timeoutMs = REAP_BUDGET_MS, _execFile } = {}) {
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

/** The recorded start matches the OS one. Our own pid needs no process spawn: the owner
 *  file we wrote carries the start time we already know. */
function startMatches(owner, { start, toleranceMs, selfPid = process.pid, selfStartMs = ownerStartMs() }) {
  if (owner.pid === selfPid) return Math.abs(selfStartMs - owner.startMs) <= toleranceMs;
  if (start == null) return true; // unknown start: a live PID is not grounds to kill
  return Math.abs(start - owner.startMs) <= toleranceMs;
}

async function ownerStillAlive(owner, { isAlive, queryStart, toleranceMs, selfPid, selfStartMs }) {
  if (!owner) return false;
  if (!isAlive(owner.pid)) return false;
  const start = owner.pid === selfPid ? null : await queryStart(owner.pid);
  return startMatches(owner, { start, toleranceMs, selfPid, selfStartMs });
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
  queryStarts = queryProcessStarts,
  selfPid = process.pid,
  selfStartMs = ownerStartMs(),
} = {}) {
  const profiles = listProfileDirs(fs, tmpDir);
  if (!profiles) return { skip: false, reason: "unreadable" };
  const owners = [];
  for (const profile of profiles) {
    const owner = readOwnerFile(profile.path, { fs });
    if (!owner) return { skip: false, reason: "no-owner" };
    if (now() - profile.mtimeMs > graceMs) return { skip: false, reason: "stale" };
    if (!isAlive(owner.pid)) return { skip: false, reason: "owner-gone" };
    owners.push(owner);
  }
  // One query for every live foreign owner: k concurrent probes must not cost k spawns.
  const foreign = [...new Set(owners.filter((owner) => owner.pid !== selfPid).map((owner) => owner.pid))];
  const starts = foreign.length === 0 ? new Map() : await queryStarts(foreign);
  for (const owner of owners) {
    if (!startMatches(owner, { start: starts.get(owner.pid), toleranceMs, selfPid, selfStartMs })) {
      return { skip: false, reason: "owner-gone" };
    }
  }
  return { skip: true, reason: profiles.length === 0 ? "clean" : "owned" };
}

/** Remove old profile folders no live browser holds. A failed removal keeps the
 *  folder for the next sweep rather than failing the launch. Async so a delete hands
 *  the loop back: a launch's budget timer can only fire between folders. */
export async function sweepProfiles({
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
    await new Promise((done) => setImmediate(done));
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
  queryStarts = queryProcessStarts,
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

  const prescan = await preScanProfiles({ fs, now, tmpDir, graceMs, toleranceMs, isAlive, queryStarts });
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
  const swept = (await sweepProfiles({ fs, now, tmpDir, platform, graceMs, liveProfiles })).removed;
  return { skipped: null, killed, failed, swept, elapsedMs: now() - started };
}
