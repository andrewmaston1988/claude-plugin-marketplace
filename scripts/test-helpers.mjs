// Shared fixtures for the runner's tests: temporary git repositories, the
// plugin graph the selection tests walk, and the spawn/log stubs main() is
// driven through.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** This directory, so a test file can locate the runner and the workflow. */
export const HERE = dirname(fileURLToPath(import.meta.url));

export const FIX_GLOB = "plugins/fix/tests/*.test.mjs";

export function git(cwd, ...args) {
  const r = spawnSync("git", args, { cwd, encoding: "utf8" });
  assert.equal(r.status, 0, `git ${args.join(" ")} failed: ${r.stderr}`);
  return r.stdout;
}

export function makeRepo(t, branch = "master") {
  const dir = mkdtempSync(join(tmpdir(), "runner-"));
  t.after(() => rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));
  git(dir, "init", "-q", "-b", branch);
  git(dir, "config", "user.email", "runner@example.com");
  git(dir, "config", "user.name", "runner");
  git(dir, "config", "core.autocrlf", "false"); // stable bytes on Windows and Linux
  git(dir, "config", "commit.gpgsign", "false");
  return dir;
}

export function write(cwd, rel, text = "x\n") {
  const path = join(cwd, rel);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text, "utf8");
}

export function commitAll(cwd, message) {
  git(cwd, "add", "-A");
  git(cwd, "commit", "-qm", message);
}

export function suiteOf(name, globs, extra = {}) {
  return { name, runs: [{ cwd: ".", globs, timeoutMs: 600000, ...extra }] };
}

/** A spawn stub: records every call, and closes (or never closes) on the next
 *  turn of the loop so the runner's listeners are attached first. */
export function stubSpawn({ code = 0, never = false, pid = 4242 } = {}) {
  const calls = [];
  const spawn = (cmd, args, opts) => {
    calls.push({ cmd, args, opts });
    const listeners = { close: [], error: [] };
    const child = { pid, once: (event, cb) => (listeners[event]?.push(cb), child) };
    if (!never) setImmediate(() => listeners.close.forEach((cb) => cb(code)));
    return child;
  };
  return { spawn, calls };
}

export function capture() {
  const lines = [];
  const errors = [];
  return { lines, errors, log: (line) => lines.push(line), err: (line) => errors.push(line) };
}

/** The fixture plugin: one module chain, one dynamic import, one URL file, one
 *  URL directory, a computed plugin-root locator, two computed `join()` paths
 *  -- and a `.win.test.mjs`. */
export function graphFixture(t) {
  const repo = makeRepo(t);
  const files = {
    "plugins/fix/src/a.mjs": "export const a = 1;\n",
    "plugins/fix/src/b.mjs": 'import { a } from "./a.mjs";\nexport const b = a;\n',
    "plugins/fix/tests/transitive.test.mjs": 'import { b } from "../src/b.mjs";\n',
    "plugins/fix/tests/unrelated.test.mjs": "export const nothing = 1;\n",
    "plugins/fix/src/dyn.mjs": "export const dyn = 1;\n",
    "plugins/fix/tests/dynamic.test.mjs": 'await import("../src/dyn.mjs");\n',
    "plugins/fix/bin/urlonly.mjs": "export const cli = 1;\n",
    "plugins/fix/tests/url-file.test.mjs":
      'const p = new URL("../bin/urlonly.mjs", import.meta.url).pathname;\n',
    "plugins/fix/templates/a.md": "template\n",
    "plugins/fix/tests/url-dir.test.mjs": 'const d = new URL("../templates", import.meta.url);\n',
    "plugins/fix/src/root.mjs": 'export const root = new URL("..", import.meta.url);\nexport const here = new URL(".", import.meta.url);\n',
    "plugins/fix/tests/root.test.mjs": 'import { root } from "../src/root.mjs";\n',
    "plugins/fix/bin/joined.mjs": "export const joined = 1;\n",
    "plugins/fix/tests/join-cli.test.mjs": 'join(here, "..", "bin", "joined.mjs");\n',
    "plugins/fix/skills/x/SKILL.md": "skill\n",
    "plugins/fix/tests/join-skill.test.mjs": 'join(SKILLS, "skills/x/SKILL.md");\n',
    "plugins/fix/package.json": "{}\n",
    "plugins/fix/package-lock.json": "{}\n",
    "plugins/fix/hooks/hooks.json": "{}\n",
    "plugins/fix/.claude-plugin/plugin.json": "{}\n",
    "plugins/fix/.codex-plugin/plugin.json": "{}\n",
    "plugins/fix/.env.test": "A=1\n",
    "plugins/fix/notes.md": "notes\n",
    // Names the fallback files from inside a closure: without the fallback
    // rule only this one test would be selected, not the whole suite.
    "plugins/fix/tests/manifest.test.mjs":
      'for (const p of ["../package.json", "../package-lock.json", "../hooks/hooks.json",\n  "../.claude-plugin/plugin.json", "../.codex-plugin/plugin.json", "../.env.test"]) new URL(p, import.meta.url);\n',
    "plugins/fix/src/tray/windows.ps1": "# tray\n",
    "plugins/fix/tests/thing.win.test.mjs": "export const w = 1;\n",
    "scripts/keep.test.mjs": "export const k = 1;\n",
  };
  for (const [rel, text] of Object.entries(files)) write(repo, rel, text);
  return repo;
}
