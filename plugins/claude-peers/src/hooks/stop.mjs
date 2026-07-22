// Stop hook: deliver held messages to sessions that cannot receive channel pushes.
//
// Channel notifications are gated behind a server-evaluated feature flag that only
// resolves on first-party auth, so a session routed through a third-party provider
// never renders them. This hook is the pull-side substitute for those sessions.
//
// It fires only when the channels flag is ABSENT: a session launched with the flag
// already got the message pushed, and draining it here would show it twice.

import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";

const CHANNEL_FLAGS = ["--dangerously-load-development-channels", "--channels"];
const PLUGIN_SPEC = "plugin:claude-peers";
const MAX_ANCESTOR_HOPS = 12;

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
 * is present AND claude-peers is inside its allowlist. Anything else means push
 * cannot reach the model, so the hook must deliver instead.
 */
export function channelsEnabled(cmd) {
  if (!cmd) return false;
  const idx = CHANNEL_FLAGS.map((f) => cmd.indexOf(f)).filter((i) => i !== -1).sort((a, b) => a - b)[0];
  if (idx === undefined) return false;
  return cmd.slice(idx).includes(PLUGIN_SPEC);
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

function descendsFrom(table, pid, ancestorPid) {
  const byPid = new Map(table.map((p) => [p.pid, p]));
  const seen = new Set();
  let cur = pid;
  for (let i = 0; i < MAX_ANCESTOR_HOPS && cur > 0 && !seen.has(cur); i++) {
    if (cur === ancestorPid) return true;
    seen.add(cur);
    const proc = byPid.get(cur);
    if (!proc) return false;
    cur = proc.ppid;
  }
  return false;
}

/**
 * Our peer is the one whose MCP process descends from this session's claude.
 * cwd alone is ambiguous — two sessions in the same directory collide.
 */
export function findMyPeer(peers, table, claudePid) {
  return peers.find((p) => descendsFrom(table, p.pid, claudePid)) ?? null;
}

function formatReason(messages) {
  const lines = messages.map((m) => `- from ${m.from_id}: ${m.text}`);
  return [
    `You have ${messages.length} peer message(s) held for you (delivered here because`,
    "channel notifications are unavailable in this session):",
    "",
    ...lines,
    "",
    "Reply with send_message if a response is warranted, then continue or stop.",
  ].join("\n");
}

/**
 * Returns a Stop-hook decision, or null to allow the stop.
 * Fails open on every error path — a broken hook must never trap a session.
 */
export async function decideStop({ payload, claude, take }) {
  if (payload?.stop_hook_active) return null;
  if (!claude) return null;
  if (channelsEnabled(claude.cmd)) return null;

  let messages;
  try {
    messages = await take();
  } catch {
    return null;
  }
  if (!Array.isArray(messages) || messages.length === 0) return null;
  return { decision: "block", reason: formatReason(messages) };
}

// --- platform process table ---

function readProcTableWindows() {
  const out = execFileSync(
    "powershell",
    ["-NoProfile", "-NonInteractive", "-Command",
      "Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,CommandLine | ConvertTo-Json -Compress"],
    { encoding: "utf8", windowsHide: true, timeout: 10000 },
  );
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
  const out = execFileSync("ps", ["-eo", "pid=,ppid=,args="], { encoding: "utf8", timeout: 10000 });
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

// --- entry point ---

export async function runStopHook({ config, _readProcTable = readProcTable, _fetch = fetch, _stdin = process.stdin } = {}) {
  let payload = {};
  try {
    const chunks = [];
    for await (const c of _stdin) chunks.push(c);
    payload = JSON.parse(Buffer.concat(chunks).toString() || "{}");
  } catch {
    return null;
  }
  if (payload.stop_hook_active) return null;

  const brokerUrl = `http://127.0.0.1:${config.port}`;
  const post = async (path, body) => {
    const res = await _fetch(`${brokerUrl}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(3000),
    });
    if (!res.ok) throw new Error(`broker ${path} ${res.status}`);
    return res.json();
  };

  let claude = null;
  let myPeer = null;
  try {
    const table = _readProcTable();
    claude = findSessionClaude(table, process.ppid);
    if (!claude || channelsEnabled(claude.cmd)) return null; // cheap exit before touching the broker
    const peers = await post("/list-peers", { include_adhoc: false, scope: "machine" });
    myPeer = findMyPeer(peers, table, claude.pid);
  } catch {
    return null;
  }
  if (!myPeer) return null;

  return decideStop({
    payload,
    claude,
    take: async () => (await post("/take-messages", { id: myPeer.id })).messages ?? [],
  });
}
