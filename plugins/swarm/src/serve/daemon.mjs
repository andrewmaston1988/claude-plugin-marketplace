// Daemon plumbing for `swarm.mjs serve`: pid file, liveness, URL discovery,
// Startup-folder autostart. Pure functions with injected paths so tests never
// touch the real home dir or spawn anything.
import { readFileSync, writeFileSync, renameSync, unlinkSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { hostname, networkInterfaces } from "node:os";

export const pidPath = (home) => join(home, "dashboard.pid");

// tmp + rename: a crash mid-write must not leave a half pid file.
export function writePid(home, pid) {
  mkdirSync(home, { recursive: true });
  const p = pidPath(home);
  writeFileSync(`${p}.tmp`, String(pid), "utf8");
  renameSync(`${p}.tmp`, p);
}
export function readPid(home) {
  try { return parseInt(readFileSync(pidPath(home), "utf8").trim(), 10) || null; } catch { return null; }
}
export function clearPid(home) {
  try { unlinkSync(pidPath(home)); } catch {}
}
export function isAlive(pid, _kill = process.kill) {
  if (!pid) return false;
  try { _kill(pid, 0); return true; } catch { return false; }
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

// Windows Startup folder launcher. `startupDir` is injectable for tests and for
// non-Windows hosts, where the caller prints the equivalent instead.
export const defaultStartupDir = (env = process.env) =>
  env.APPDATA ? join(env.APPDATA, "Microsoft", "Windows", "Start Menu", "Programs", "Startup") : null;
export const launcherPath = (startupDir) => join(startupDir, "swarm-dashboard.cmd");

export function installAutostart({ startupDir, nodePath, enginePath }) {
  if (!startupDir) return { installed: false, reason: "no Startup folder on this platform" };
  mkdirSync(startupDir, { recursive: true });
  const body = `@echo off\r\nstart "" /min "${nodePath}" "${enginePath}" serve --daemon\r\n`;
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
