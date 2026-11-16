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

export function cmdFor(profile, exe = "msedge.exe") {
  return `"C:\\Browsers\\${exe}" --headless=new --remote-debugging-port=0 --user-data-dir="${profile}"`;
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
