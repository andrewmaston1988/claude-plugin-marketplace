import { test } from "node:test";
import { equal, ok } from "node:assert/strict";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { loadManifest } from "./helpers/repo-io.mjs";
import { CFG, writeManifest, tmp, errorsOf } from "./helpers/manifest-fixtures.mjs";
import * as leafGuard from "../src/manifest-leaf-guard.mjs";

test("governance: a real repo lookup spawn failure is reported as git failure and retried once", () => {
  const repo = tmp();
  const home = tmp();
  const cwd = join(home, "runs", "kept-worktree");
  mkdirSync(cwd, { recursive: true });
  try {
    const calls = [];
    const spawn = (...args) => {
      calls.push(args);
      return { error: Object.assign(new Error("spawn EAGAIN"), { code: "EAGAIN" }) };
    };
    const repoToplevel = (path) => path === repo ? repo : leafGuard.realRepoToplevel(path);
    const p = writeManifest(repo, {
      tasks: [{ id: "o", prompt: "p", provider: "claude", model: "claude-haiku-4-5-20251001", cwd }],
    });
    const cfg = { ...CFG, providers: { claude: { enabled: true, allowedRoots: [repo] } } };
    const errors = errorsOf(() => loadManifest(p, cfg, repo, {
      io: { home, repoToplevel, repoLookup: (path) => leafGuard.repoLookup(path, spawn) },
    }));
    ok(errors.some((error) => /git.*lookup.*fail|lookup.*git.*fail/i.test(error)), errors.join("|") || "lookup unexpectedly passed");
    equal(calls.length, 2, "validation retries one failed repo lookup");
  } finally {
    rmSync(repo, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});

test("repoLookup: spawn error and signal are failures, not outside-roots answers", () => {
  const cwd = tmp();
  try {
    const spawnError = leafGuard.repoLookup(cwd, () => ({ error: new Error("spawn EAGAIN") }));
    ok(spawnError.failed, JSON.stringify(spawnError));
    const signal = leafGuard.repoLookup(cwd, () => ({ status: null, signal: "SIGTERM" }));
    ok(signal.failed, JSON.stringify(signal));
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("repoLookup: not-a-repository and missing cwd are outside-roots answers", () => {
  const cwd = tmp();
  try {
    const notRepo = leafGuard.repoLookup(cwd, () => ({ status: 128, stderr: "fatal: not a git repository" }));
    equal(notRepo.none, "not-a-repo");
    const missing = leafGuard.repoLookup(join(cwd, "missing"), () => {
      throw new Error("missing cwd must not spawn git");
    });
    equal(missing.none, "missing-cwd");
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});
