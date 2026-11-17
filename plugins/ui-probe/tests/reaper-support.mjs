import { mkdirSync, mkdtempSync, rmSync, utimesSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { PROFILE_PREFIX } from "../src/reaper.mjs";

export const OLD = 2 * 60 * 60 * 1000;

export function tempRoot(t) {
  const dir = mkdtempSync(join(tmpdir(), "ui-probe-reaper-test-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

export function profileFolder(root, suffix) {
  const path = join(root, `${PROFILE_PREFIX}${suffix}`);
  mkdirSync(path);
  return path;
}

export function aged(path, ms = OLD) {
  const seconds = (Date.now() - ms) / 1000;
  utimesSync(path, seconds, seconds);
}

// The launcher passes one argv element, and node quotes the whole argument only when it
// contains a space — the shape every ownership row must be written against.
export function cmdFor(profile, exe = "msedge.exe") {
  const arg = `--user-data-dir=${profile}`;
  const quoted = /\s/.test(profile) ? `"${arg}"` : arg;
  return `"C:\\Browsers\\${exe}" --headless=new --remote-debugging-port=0 ${quoted}`;
}

export function recorder() {
  const calls = [];
  const kill = (pids, options) => {
    calls.push({ pids, options });
    return { killed: pids };
  };
  kill.calls = calls;
  return kill;
}
