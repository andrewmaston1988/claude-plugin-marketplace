// The OS-facing half of the reaper: listing processes, asking when one started, and
// stopping a batch by PID. Async on purpose throughout — launch() caps the reap with a
// timer on this same event loop, and a synchronous spawn would block that timer for as
// long as the child ran.

import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFileCallback);

export const REAP_BUDGET_MS = 5000;
const PROCESS_QUERY_TIMEOUT_MS = 3000;
const LOCK_TIMEOUT_MS = 5000;
const MAX_BUFFER = 4 * 1024 * 1024;
// Stop-Process returns before the process is gone, and a browser root takes its children with it.
const KILL_SETTLE_TRIES = 5;
const KILL_SETTLE_MS = 100;

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

// --- process listing ----------------------------------------------------------

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

function parseStartTime(text) {
  const value = String(text ?? "").trim();
  if (!value) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
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

/** Creation times for many PIDs in one call: k live owners must not cost k spawns.
 *  A PID the OS does not answer for stays null, which reads as unknown, never as reused. */
export async function queryProcessStarts(pids, {
  platform = process.platform,
  _execFile = execFileAsync,
  timeoutMs = PROCESS_QUERY_TIMEOUT_MS,
} = {}) {
  const ids = [...new Set((pids ?? []).filter((pid) => Number.isInteger(pid) && pid > 0))];
  const starts = new Map(ids.map((pid) => [pid, null]));
  if (ids.length === 0) return starts;
  const record = (pid, start) => {
    if (start != null && starts.has(pid)) starts.set(pid, start);
  };
  try {
    if (platform === "win32") {
      const filter = ids.map((pid) => `ProcessId=${pid}`).join(" or ");
      const stdout = await runPowerShell(
        `Get-CimInstance Win32_Process -Filter "${filter}" ` +
          "| Select-Object ProcessId,@{n='Start';e={ $_.CreationDate.ToUniversalTime().ToString('o') }} " +
          "| ConvertTo-Json -Compress",
        { _execFile, timeoutMs },
      );
      const text = String(stdout ?? "").replace(/[\u0000-\u001f]+/g, " ").trim();
      if (text) {
        const rows = JSON.parse(text);
        for (const row of Array.isArray(rows) ? rows : [rows]) record(row?.ProcessId, parseStartTime(row?.Start));
      }
      return starts;
    }
    const options = { encoding: "utf8", windowsHide: true, timeout: timeoutMs };
    const stdout = (await _execFile("ps", ["-o", "pid=,lstart=", "-p", ids.join(",")], options)).stdout;
    for (const line of String(stdout ?? "").split(/\r?\n/)) {
      const match = /^\s*(\d+)\s+(.+)$/.exec(line);
      if (match) record(Number(match[1]), parseStartTime(match[2]));
    }
    return starts;
  } catch {
    return starts;
  }
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
export async function killPids(pids, {
  platform = process.platform,
  _execFile = execFileAsync,
  _kill = process.kill,
  _alive = pidAlive,
  _sleep = (ms) => new Promise((done) => setTimeout(done, ms)),
  timeoutMs = LOCK_TIMEOUT_MS,
} = {}) {
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
  // A killed browser the kernel has not reaped still answers kill(pid, 0), so settling is what
  // separates a survivor from a slow death — the same discipline as the Windows branch.
  let survivors = new Set(ids.filter((pid) => _alive(pid)));
  for (let i = 0; i < KILL_SETTLE_TRIES && survivors.size > 0; i++) {
    await _sleep(KILL_SETTLE_MS);
    survivors = new Set([...survivors].filter((pid) => _alive(pid)));
  }
  return split(survivors);
}
