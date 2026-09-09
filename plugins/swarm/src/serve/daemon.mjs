// Daemon plumbing for `swarm.mjs serve`: pid record, liveness, URL discovery,
// Startup-folder autostart, staleness against the plugin registry, doctor's
// checks. Pure functions with injected paths so tests never touch the real home
// dir or spawn anything.
import { readFileSync, writeFileSync, renameSync, unlinkSync, existsSync, mkdirSync, copyFileSync } from "node:fs";
import { join } from "node:path";
import { hostname, networkInterfaces, homedir } from "node:os";
import { connect } from "node:net";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

export const pidPath = (home) => join(home, "dashboard.pid");

// The pid file is a JSON RECORD, not a bare integer: status, doctor and the tray
// all need the port, version and start time alongside the pid to say anything
// about a running daemon. tmp + rename: a crash mid-write must not leave a half
// record. Both writers (--daemon parent pre-fork, child pre-listen) agree on
// pid; the child's post-listen rewrite only adds `listening`.
export function writePid(home, record) {
  mkdirSync(home, { recursive: true });
  const p = pidPath(home);
  writeFileSync(`${p}.tmp`, JSON.stringify(record) + "\n", "utf8");
  renameSync(`${p}.tmp`, p);
}
// A bare-integer file (a daemon started before the record format) still reads as
// `{ pid }` so `serve stop` can kill it; that back-compat branch is deleted at
// the next major, not now. Anything unparsable or pid-less reads as null —
// never a partially-populated record.
export function readPid(home) {
  try {
    const raw = readFileSync(pidPath(home), "utf8").trim();
    if (!raw) return null;
    if (/^\d+$/.test(raw)) return { pid: parseInt(raw, 10) };
    const r = JSON.parse(raw);
    return r && typeof r === "object" && Number.isInteger(r.pid) ? r : null;
  } catch { return null; }
}
export function clearPid(home) {
  try { unlinkSync(pidPath(home)); } catch {}
}
export function isAlive(pid, _kill = process.kill) {
  if (!pid) return false;
  try { _kill(pid, 0); return true; } catch { return false; }
}

// The plugin registry — the SAME file statusline/resolver.mjs reads; its path and
// the user-scoped / newest-lastUpdated selection are mirrored here and must stay
// in step (resolver.mjs is the other reader; env override honoured for the same
// rehearsals).
export const PLUGIN_KEY = "swarm@andrewmaston1988-claude-plugins";
export const registryPath = (env = process.env) =>
  env.SWARM_PLUGIN_REGISTRY || join(homedir(), ".claude", "plugins", "installed_plugins.json");

// { installPath, version } of the active swarm entry, or null. Never throws: an
// unreadable or mid-write registry is "unknown", and unknown must never move a
// daemon.
export function resolveInstalled({ registry = registryPath(), readFile = readFileSync } = {}) {
  try {
    const entries = JSON.parse(readFile(registry, "utf8"))?.plugins?.[PLUGIN_KEY] ?? [];
    const userScoped = entries.filter((e) => e.scope === "user");
    const pool = userScoped.length ? userScoped : entries;
    pool.sort((a, b) => (b.lastUpdated || "").localeCompare(a.lastUpdated || ""));
    return pool[0]?.installPath ? { installPath: pool[0].installPath, version: pool[0].version ?? null } : null;
  } catch { return null; }
}

// Stale = the VERSION moved, nothing else: an install-path change alone is not a
// restart signal, a missing/unreadable registry entry is never one (that would
// loop the daemon the first time the registry blips), and a record without a
// version (old format) is not upgradable in place — `serve restart` is that path.
export function isStale(record, installed) {
  return Boolean(record?.version && installed?.version && record.version !== installed.version);
}

// The `already running` short-circuit, version-aware: a live daemon that is not
// us blocks a new start — unless its version has moved off the registry's, in
// which case starting is a takeover (the update watcher's re-exec and a manual
// `serve` against a stale daemon both come through here). Unknown registry →
// block, exactly like today.
export function blocksStart(record, installed, ownPid, alive) {
  if (!alive || !record?.pid || record.pid === ownPid) return false;
  return !isStale(record, installed);
}

// After a failed bind the pid record must still reach whoever IS serving: hand it
// back to a live rival we displaced, clear it if it was ours, leave it alone if
// ownership already moved on. Returned as a decision so the caller applies it —
// a failed replacement must never leave a live daemon recordless (`serve stop`
// could then never reach it).
export function bindFailureRecordAction({ current, prevRecord, ownPid, alive }) {
  if (current?.pid !== ownPid) return { act: "leave" };
  if (prevRecord?.pid && prevRecord.pid !== ownPid && alive(prevRecord.pid)) return { act: "restore", record: prevRecord };
  return { act: "clear" };
}

// Poll the pid record until a daemon reports listening. `excludePid` is a record
// not to count (a takeover waits for a NEW pid). The two failure shapes a
// handover must catch fast: the record clearing (the replacement's own
// bind-failure path when it had no rival to restore) and the record reverting to
// excludePid (the replacement restored a live old record and gave up).
export async function waitForDaemon({
  read, isAlive: alive, excludePid = null,
  failOnCleared = false, revertIsFailure = false,
  deadlineMs = 15000, pollMs = 250,
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)), now = Date.now,
}) {
  const deadline = now() + deadlineMs;
  let sawOther = false;
  for (;;) {
    const r = read();
    if (!r || !r.pid) {
      if (failOnCleared && sawOther) return { ok: false, reason: "the pid record was cleared — the replacement failed to start" };
    } else if (r.pid !== excludePid) {
      sawOther = true;
      if (r.listening && alive(r.pid)) return { ok: true, record: r };
      if (!alive(r.pid)) return { ok: false, reason: `pid ${r.pid} died before listening` };
    } else if (sawOther && revertIsFailure) {
      return { ok: false, reason: "the pid record reverted — the replacement failed and restored the old daemon's record" };
    }
    if (now() >= deadline) return { ok: false, reason: `timed out after ${deadlineMs}ms waiting for a listening daemon` };
    await sleep(pollMs);
  }
}

// What to print at start: the mDNS name phones resolve, every LAN IPv4, and the
// one-time elevated firewall rule — printed, never run.
export function urlLines(port, { host = hostname(), ifaces = networkInterfaces() } = {}) {
  const lines = [`http://${host.toLowerCase()}.local:${port}/`];
  for (const list of Object.values(ifaces)) {
    for (const i of list || []) if (i.family === "IPv4" && !i.internal) lines.push(`http://${i.address}:${port}/`);
  }
  return lines;
}
export const firewallHint = (port) =>
  `netsh advfirewall firewall add rule name="swarm dashboard" dir=in action=allow protocol=TCP localport=${port}`;

const fmtTime = (ms) => (ms ? new Date(ms).toISOString().replace("T", " ").slice(0, 19) : "unknown");

// Does the Startup launcher exist and point at the stable shim? A launcher
// pinned to the sha-versioned plugin cache dir is the silent-stale-install
// failure this check exists to catch.
export function launcherState({ startupDir, shimPath }) {
  if (!startupDir) return { state: "no-platform", detail: "no Startup folder on this platform" };
  let body;
  try { body = readFileSync(launcherPath(startupDir), "utf8"); } catch { return { state: "missing", detail: "not installed" }; }
  if (body.includes(shimPath) && !/plugins[\\/]cache/.test(body)) return { state: "ok", detail: launcherPath(startupDir) };
  return { state: "mispointed", detail: `${launcherPath(startupDir)} does not point at ${shimPath} — re-run serve install-autostart` };
}

// `serve status` — three states, three prints: not running / running current /
// running a version the registry has moved off. Stale still exits 0 (the daemon
// IS serving); `serve doctor` is the verb that fails on it.
export function statusReport({ record, alive, installed, port, urls = [], startupDir = null, shimPath }) {
  if (!alive || !record?.pid) return { state: "not-running", exit: 1, lines: ["dashboard: not running"] };
  const lines = [`dashboard: running (pid ${record.pid}, port ${record.port ?? port}, started ${fmtTime(record.startedMs)})`];
  const runningV = record.version ?? null;
  const installedV = installed?.version ?? null;
  if (runningV && installedV && runningV !== installedV) {
    lines.push(`  version: ${runningV} (stale — installed ${installedV}; serve restart applies it)`);
  } else {
    lines.push(`  version: ${runningV ?? "unknown"}`);
    if (!installedV) lines.push("  installed version: unknown (registry unreadable)");
  }
  const l = launcherState({ startupDir, shimPath });
  lines.push(`  autostart: ${l.state === "ok" ? `installed → ${l.detail}` : l.detail}`);
  for (const u of urls) lines.push(`  ${u}`);
  return { state: runningV && installedV && runningV !== installedV ? "stale" : "running", exit: 0, lines };
}

// ── doctor ───────────────────────────────────────────────────────────────────
// Reports, never repairs. Each check is pass / fail / UNKNOWN: unknown never
// fails the run — the firewall rule cannot be read without elevation on some
// setups, and a doctor that cries wolf there gets ignored everywhere else.

// TCP probe of the dashboard port. `bind` 0.0.0.0 is probed via loopback.
export function probePort(port, bind, timeoutMs = 1500) {
  return new Promise((resolve) => {
    const host = !bind || bind === "0.0.0.0" || bind === "::" ? "127.0.0.1" : bind;
    const sock = connect({ port, host }, () => { sock.destroy(); resolve({ reachable: true }); });
    sock.on("error", (e) => resolve({ reachable: false, error: e.message }));
    sock.setTimeout(timeoutMs, () => { sock.destroy(); resolve({ reachable: false, error: "timeout" }); });
  });
}

// `netsh` read of the firewall rule. Elevation problems come back as
// { error } — unknown, not fail.
const execFileAsync = promisify(execFile);
export async function readFirewallRule(ruleName = "swarm dashboard") {
  try {
    const { stdout } = await execFileAsync("netsh", ["advfirewall", "firewall", "show", "rule", `name=${ruleName}`], { timeout: 8000, windowsHide: true });
    return { found: /Rule Name|规则名称|Regelname/.test(stdout) || stdout.includes(ruleName), text: stdout };
  } catch (e) {
    return { error: e.message };
  }
}

export async function doctorChecks({ record, alive, installed, port, bind = "0.0.0.0", startupDir, shimPath, _probePort = probePort, _firewall = readFirewallRule }) {
  const checks = [];
  const p = await _probePort(port, bind);
  checks.push({ name: "port", status: p.reachable ? "pass" : "fail", detail: p.reachable ? `reachable on ${port}` : `nothing listening on ${port}` });

  checks.push({ name: "pid", status: alive ? "pass" : "fail", detail: alive ? `pid ${record.pid} alive` : "no live daemon — start with: swarm serve --daemon" });

  const l = launcherState({ startupDir, shimPath });
  checks.push({ name: "autostart", status: l.state === "ok" ? "pass" : l.state === "no-platform" ? "unknown" : "fail", detail: l.detail });

  const runningV = record?.version ?? null;
  const installedV = installed?.version ?? null;
  if (!alive) checks.push({ name: "version", status: "unknown", detail: "not running" });
  else if (!runningV) checks.push({ name: "version", status: "unknown", detail: "running record predates version tracking — serve restart upgrades it" });
  else if (!installedV) checks.push({ name: "version", status: "unknown", detail: "registry unreadable" });
  else if (runningV === installedV) checks.push({ name: "version", status: "pass", detail: runningV });
  else checks.push({ name: "version", status: "fail", detail: `running ${runningV}, installed ${installedV} — serve restart applies it` });

  const fw = await _firewall();
  if (fw.error) checks.push({ name: "firewall", status: "unknown", detail: `cannot read the rule (${fw.error}) — elevated netsh may be required` });
  else if (fw.found) checks.push({ name: "firewall", status: "pass", detail: `"swarm dashboard" rule present` });
  else checks.push({ name: "firewall", status: "fail", detail: `no "swarm dashboard" rule — run (elevated): ${firewallHint(port)}` });
  return checks;
}
export const doctorExit = (checks) => (checks.some((c) => c.status === "fail") ? 1 : 0);

// Windows Startup folder launcher. `startupDir` is injectable for tests and for
// non-Windows hosts, where the caller prints the equivalent instead.
export const defaultStartupDir = (env = process.env) =>
  env.APPDATA ? join(env.APPDATA, "Microsoft", "Windows", "Start Menu", "Programs", "Startup") : null;
export const launcherPath = (startupDir) => join(startupDir, "swarm-dashboard.cmd");

// `enginePath` must be a STABLE path — the ~/.swarm resolver shim, not this file. Baking
// the plugin's sha-versioned cache dir into the launcher pinned it to whichever build ran
// the install: every `claude plugin update` then left the machine booting an older
// dashboard with nothing to say so (observed pinned 3 versions behind, 2026-09-05).
export function installAutostart({ startupDir, nodePath, enginePath, engineArgs = ["serve", "--daemon"] }) {
  if (!startupDir) return { installed: false, reason: "no Startup folder on this platform" };
  mkdirSync(startupDir, { recursive: true });
  const body = `@echo off\r\nstart "" /min "${nodePath}" "${enginePath}" ${engineArgs.join(" ")}\r\n`;
  const p = launcherPath(startupDir);
  const already = existsSync(p) && readFileSync(p, "utf8") === body;
  if (!already) writeFileSync(p, body, "utf8");
  return { installed: true, path: p, changed: !already };
}
export function uninstallAutostart({ startupDir }) {
  if (!startupDir) return { removed: false };
  const p = launcherPath(startupDir);
  if (!existsSync(p)) return { removed: false, path: p };
  unlinkSync(p);
  return { removed: true, path: p };
}

// The stable shim every launch path must go through (~/.swarm/serve.mjs): the
// Startup launcher, the tray's verbs, the update watcher's re-exec. Refreshed on
// every daemon start so a resolver fix cannot strand a stale copy.
export function ensureShim({ home, resolverSrc, copyFile = copyFileSync }) {
  mkdirSync(home, { recursive: true });
  const dst = join(home, "serve.mjs");
  copyFile(resolverSrc, dst);
  return dst;
}
// Poll until a signalled process is actually gone. `serve restart` must not
// start a replacement while the old daemon still holds the port — that race is
// what leaves zero daemons listening once the old one finally exits.
export async function waitForExit(pid, {
  isAlive: alive = isAlive, deadlineMs = 10000, pollMs = 100,
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)), now = Date.now,
} = {}) {
  const deadline = now() + deadlineMs;
  for (;;) {
    if (!alive(pid)) return { exited: true };
    if (now() >= deadline) return { exited: false, reason: `pid ${pid} still alive after ${deadlineMs}ms` };
    await sleep(pollMs);
  }
}

// What `serve restart` may do, given what the signalled daemon did. Separated
// from the verb because the dangerous case is unreachable through the CLI in a
// test: a daemon that ignores the signal must leave us starting NOTHING and
// clearing NOTHING — a record cleared out from under a live daemon is a daemon
// `serve stop` can never reach again.
export function restartPlan({ record, wasAlive, exited }) {
  if (!record?.pid || !wasAlive) return { act: "start", clearRecord: true, reason: "not running" };
  if (!exited) return { act: "abort", clearRecord: false, reason: "the old daemon did not exit — it is still serving" };
  return { act: "start", clearRecord: true, reason: "stopped" };
}
