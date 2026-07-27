// Detect whether this session can render our channel notifications.
//
// Channel blocks only render when the session was launched with a channels flag
// naming this plugin. Sessions routed through third-party providers never get
// one, so they must be told to poll instead of waiting for a push.

import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";

const CHANNEL_FLAGS = ["--dangerously-load-development-channels", "--channels"];
const PLUGIN_SPEC = "plugin:claude-peers";
const MAX_ANCESTOR_HOPS = 12;
// This runs inside the MCP `initialize` handler, so it blocks the handshake.
// Overrunning must degrade to "poll", never stall the client's connect.
const PROC_TABLE_TIMEOUT_MS = 3000;

/** First whitespace-separated token, honouring a leading quoted path. */
function firstToken(cmd) {
  const m = /^\s*"([^"]+)"|^\s*(\S+)/.exec(cmd ?? "");
  return m ? (m[1] ?? m[2]) : "";
}

function isClaudeProcess(cmd) {
  const exe = firstToken(cmd).replace(/\\/g, "/").split("/").pop() ?? "";
  return exe.replace(/\.exe$/i, "").toLowerCase() === "claude";
}

/**
 * True when this session can render our channel notifications: the channels flag
 * is present AND claude-peers is inside its allowlist.
 */
export function channelsEnabled(cmd) {
  if (!cmd) return false;
  const tokens = cmd.match(/\S+/g) ?? [];
  const namesUs = (t) => t === PLUGIN_SPEC || t.startsWith(`${PLUGIN_SPEC}@`);
  for (let i = 0; i < tokens.length; i++) {
    const eq = tokens[i].indexOf("=");
    const flag = eq === -1 ? tokens[i] : tokens[i].slice(0, eq);
    if (!CHANNEL_FLAGS.includes(flag)) continue;
    if (eq !== -1) { if (namesUs(tokens[i].slice(eq + 1))) return true; continue; }
    // only the flag's own contiguous plugin: values count — a later mention
    // (a -p prompt body, a different flag) is not an allowlist entry
    for (let j = i + 1; j < tokens.length && tokens[j].startsWith("plugin:"); j++) {
      if (namesUs(tokens[j])) return true;
    }
  }
  return false;
}

/** Walk parents from startPid to the owning claude process. Null if none. */
export function findSessionClaude(table, startPid) {
  const byPid = new Map(table.map((p) => [p.pid, p]));
  const seen = new Set();
  let pid = startPid;
  for (let i = 0; i < MAX_ANCESTOR_HOPS && pid > 0 && !seen.has(pid); i++) {
    seen.add(pid);
    const proc = byPid.get(pid);
    if (!proc) return null;
    if (isClaudeProcess(proc.cmd)) return { pid: proc.pid, cmd: proc.cmd };
    pid = proc.ppid;
  }
  return null;
}

// --- platform process table ---

export function readProcTableWindows(_execFileSync = execFileSync) {
  const args = ["-NoProfile", "-NonInteractive", "-Command",
    "Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,CommandLine | ConvertTo-Json -Compress"];
  let out;
  // both shells are individually absent on real Windows images — don't collapse to one
  for (const exe of ["pwsh", "powershell"]) {
    try {
      out = _execFileSync(exe, args, { encoding: "utf8", windowsHide: true, timeout: PROC_TABLE_TIMEOUT_MS });
      break;
    } catch (e) {
      // fall back only when the binary is absent; a timeout must not buy a second budget
      if (exe === "powershell" || e.code !== "ENOENT") throw e;
    }
  }
  const rows = JSON.parse(out);
  return (Array.isArray(rows) ? rows : [rows]).map((r) => ({
    pid: r.ProcessId, ppid: r.ParentProcessId, cmd: r.CommandLine ?? "",
  }));
}

function readProcTableLinux() {
  return readdirSync("/proc")
    .filter((d) => /^\d+$/.test(d))
    .map((d) => {
      try {
        const cmd = readFileSync(`/proc/${d}/cmdline`, "utf8").replace(/\0/g, " ").trim();
        const stat = readFileSync(`/proc/${d}/stat`, "utf8");
        const ppid = parseInt(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[1], 10);
        return { pid: parseInt(d, 10), ppid, cmd };
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

function readProcTablePosix() {
  const out = execFileSync("ps", ["-eo", "pid=,ppid=,args="], { encoding: "utf8", timeout: PROC_TABLE_TIMEOUT_MS });
  return out.split("\n").filter(Boolean).map((line) => {
    const m = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line);
    return m ? { pid: +m[1], ppid: +m[2], cmd: m[3] } : null;
  }).filter(Boolean);
}

export function readProcTable() {
  if (process.platform === "win32") return readProcTableWindows();
  if (process.platform === "linux") return readProcTableLinux();
  return readProcTablePosix();
}

/**
 * Resolve channel availability for the session that owns this process.
 * Unknown resolves to false — a needless poll costs a turn every 3 minutes,
 * a missed push costs the message.
 */
export function detectChannelsEnabled({ _readProcTable = readProcTable, _ppid = process.ppid } = {}) {
  try {
    const claude = findSessionClaude(_readProcTable(), _ppid);
    return claude ? channelsEnabled(claude.cmd) : false;
  } catch {
    return false;
  }
}
