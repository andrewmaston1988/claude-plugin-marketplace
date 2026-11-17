// Shared fixtures for the file-size bar tests: real temporary git repositories.
// The interesting failures live in how the line triples are DERIVED, so both
// test files drive the real CLI against real trees.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));

export const ROOT = join(HERE, "..");
const CHECKER = join(HERE, "check-file-size.mjs");

export function git(cwd, ...args) {
  const r = spawnSync("git", args, { cwd, encoding: "utf8" });
  assert.equal(r.status, 0, `git ${args.join(" ")} failed: ${r.stderr}`);
  return r.stdout;
}

export function makeRepo(t) {
  const dir = mkdtempSync(join(tmpdir(), "ratchet-"));
  t.after(() => rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));
  git(dir, "init", "-q");
  git(dir, "config", "user.email", "ratchet@example.com");
  git(dir, "config", "user.name", "ratchet");
  git(dir, "config", "core.autocrlf", "false"); // stable bytes on Windows and Linux
  git(dir, "config", "commit.gpgsign", "false");
  return dir;
}

export function writeLines(cwd, rel, n) {
  const p = join(cwd, rel);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, "x = 1\n".repeat(n), "utf8");
}

export function commitAll(cwd, message) {
  git(cwd, "add", "-A");
  git(cwd, "commit", "-qm", message);
}

export function runChecker(cwd, ...args) {
  return spawnSync(process.execPath, [CHECKER, ...args], { cwd, encoding: "utf8" });
}
