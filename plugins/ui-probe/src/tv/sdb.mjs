// sdb is the only route onto the TV. Every argv it may run is named here, and a
// refused call throws before it reaches the wire.

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const SDB_TIMEOUT_MS = 30000;

// Where the Tizen VS Code extension and Tizen Studio put sdb.
const SDK_LAYOUTS = [".tizen-extension-platform/server/sdktools/data/tools/sdb", "tizen-studio/tools/sdb"];

export class SdbRefused extends Error {
  constructor(args) {
    super(`sdb ${args.join(" ")} is off the allowlist`);
    this.name = "SdbRefused";
    this.args = [...args];
  }
}

/** `shell 0 kill` takes the package id, not the app id: torrenthub.main -> torrenthub. */
export function packageId(appid) {
  return String(appid ?? "").split(".")[0];
}

export function findSdb(config, { _exists = existsSync, _spawnSync = spawnSync, _home = homedir } = {}) {
  const configured = config?.tv?.sdb;
  if (configured && _exists(configured)) return configured;

  const lookup = process.platform === "win32" ? "where" : "which";
  const found = _spawnSync(lookup, ["sdb"], { encoding: "utf8", windowsHide: true });
  const onPath = String(found?.stdout ?? "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)[0];
  if (onPath) return onPath;

  const extensions = process.platform === "win32" ? [".exe", ""] : ["", ".exe"];
  for (const layout of SDK_LAYOUTS) {
    for (const extension of extensions) {
      const candidate = join(_home(), `${layout}${extension}`);
      if (_exists(candidate)) return candidate;
    }
  }
  return null;
}

const IP_PORT = /^\d{1,3}(?:\.\d{1,3}){3}:\d+$/;
const TCP = /^tcp:(\d+)$/;

function allowed(args, appid) {
  if (!Array.isArray(args) || !args.every((arg) => typeof arg === "string")) return false;
  const [first, second, third, fourth] = args;

  if (args.length === 1 && (first === "devices" || first === "version")) return true;
  if (args.length === 2 && first === "connect" && IP_PORT.test(second)) return true;
  if (args.length === 2 && first === "forward" && second === "--list") return true;
  if (args.length === 3 && first === "forward" && second === "--remove" && TCP.test(third)) return true;
  if (args.length === 3 && first === "forward" && TCP.test(second) && TCP.test(third)) {
    return TCP.exec(second)[1] === TCP.exec(third)[1];
  }
  if (args.length === 3 && first === "shell" && second === "0" && third === "applist") return true;

  // The only app this tool may launch or close is the one in config.
  if (!appid || args.length !== 4 || first !== "shell" || second !== "0") return false;
  if (third === "debug") return fourth === appid;
  if (third === "kill") return fourth === packageId(appid);
  return false;
}

export function allowSdb(args, { appid } = {}) {
  const argv = Array.isArray(args) ? args : [String(args)];
  if (!allowed(argv, appid)) throw new SdbRefused(argv);
}

export function sdb(args, { config, _spawn = spawnSync, _findSdb = findSdb, timeoutMs = SDB_TIMEOUT_MS } = {}) {
  allowSdb(args, { appid: config?.tv?.appid });

  const command = _findSdb(config);
  if (!command) {
    throw new Error("sdb not found: set tv.sdb in .ui-probe.json, install the Tizen SDK, or put sdb on PATH");
  }

  const result = _spawn(command, args, { encoding: "utf8", timeout: timeoutMs, windowsHide: true, shell: false });
  return {
    stdout: result?.stdout ?? "",
    stderr: result?.stderr ?? "",
    code: result?.status ?? (result?.error ? 2 : 0),
  };
}

/** The `device` rows of `sdb devices`, by serial; attach and doctor both read this. */
export function listedDevices(stdout) {
  return String(stdout ?? "")
    .split(/\r?\n/)
    .map((line) => line.trim().split(/\s+/))
    .filter((parts) => parts.length >= 2 && parts[1] === "device")
    .map((parts) => parts[0]);
}

/** `... successfully launched pid = 921 with debug 1 port: 46770` -> 46770. */
export function parseDebugPort(stdout) {
  const match = String(stdout ?? "").match(/port[:\s]+(\d{2,5})/i);
  return match ? Number(match[1]) : null;
}
