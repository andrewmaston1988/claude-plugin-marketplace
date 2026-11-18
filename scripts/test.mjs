// Self-installing shim into the test-runner package. A fresh worktree has no
// root `npm ci`, and TESTING.md and every leaf brief name this file.

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import * as nodeFs from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/** The repository root: the parent of `scripts/`, never `process.cwd()`. */
const ROOT = fileURLToPath(new URL("..", import.meta.url));

// Same record path and hash the package's own installIfNeeded uses, so the
// shim and a mirror-side `--mirror` install share one gate.
const RECORD = "node_modules/.test-install-hash";
const PACKAGE = "node_modules/test-runner/package.json";

function readRecord(path, _fs) {
  try {
    return String(_fs.readFileSync(path, "utf8")).trim();
  } catch {
    return null; // absent or unreadable: reinstall
  }
}

/** `npm ci` in the repo root whenever the package is missing or the lockfile
 *  bytes differ from the recorded hash. Skipped under CI, where every job runs
 *  its own `npm ci` step before the shim. */
export function ensureInstalled({
  root,
  _fs = nodeFs,
  _spawnSync = spawnSync,
  _platform = process.platform,
  _env = process.env,
}) {
  if (_env.CI === "true") return { installed: false };
  const lockfile = join(root, "package-lock.json");
  if (!_fs.existsSync(lockfile)) {
    return { installed: false, error: `no package-lock.json at ${root} — run npm install` };
  }
  const hash = createHash("sha256").update(_fs.readFileSync(lockfile)).digest("hex");
  const record = join(root, RECORD);
  if (_fs.existsSync(join(root, PACKAGE)) && readRecord(record, _fs) === hash) return { installed: false };
  const shell = _platform === "win32"; // npm is npm.cmd here, which spawn cannot exec directly
  // An args array with shell:true is DEP0190, so the shell path passes one string.
  const result = shell
    ? _spawnSync("npm ci", [], { cwd: root, stdio: "inherit", shell })
    : _spawnSync("npm", ["ci"], { cwd: root, stdio: "inherit", shell });
  if (!result || result.error || result.status !== 0) {
    const detail = result && result.error ? result.error.message : `exit ${result ? result.status : "unknown"}`;
    return { installed: false, error: `npm ci failed in ${root} (${detail})` };
  }
  _fs.mkdirSync(join(root, "node_modules"), { recursive: true });
  _fs.writeFileSync(record, hash);
  return { installed: true };
}

function isEntryPoint() {
  if (!process.argv[1]) return false;
  try {
    return nodeFs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
}

// Only when invoked directly: importing this module from a test must not install.
if (isEntryPoint()) {
  const { installed, error } = ensureInstalled({ root: ROOT });
  if (error) {
    process.stderr.write(`[test] ${error}\n`);
    process.exitCode = 2;
  } else {
    if (installed) process.stderr.write("[test] installed test-runner (lockfile changed)\n");
    await import("test-runner/bin/test-runner.mjs"); // the CLI reads process.argv itself
  }
}
