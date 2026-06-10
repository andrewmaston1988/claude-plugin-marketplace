import { test } from "node:test";
import { equal, match } from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync, spawnSync } from "node:child_process";
import {
  detectDefaultBranch,
  DEFAULT_TARGET_BRANCH_FALLBACK,
} from "../src/cli/helpers.mjs";

function freshRepo({ withOriginHead = null, configDefault = null } = {}) {
  const tmp = mkdtempSync(join(tmpdir(), "pipeline-tb-"));
  execFileSync("git", ["init", "-q"], { cwd: tmp });
  execFileSync("git", ["config", "user.email", "t@t"], { cwd: tmp });
  execFileSync("git", ["config", "user.name", "t"], { cwd: tmp });
  if (configDefault) {
    execFileSync("git", ["config", "init.defaultBranch", configDefault], { cwd: tmp });
  } else {
    // Strip local override so the test relies only on remote HEAD presence.
    spawnSync("git", ["config", "--unset", "init.defaultBranch"], { cwd: tmp });
  }
  if (withOriginHead) {
    execFileSync("git", ["checkout", "-q", "-b", withOriginHead], { cwd: tmp });
    writeFileSync(join(tmp, "f"), "x");
    execFileSync("git", ["add", "."], { cwd: tmp });
    execFileSync("git", ["commit", "-qm", "init"], { cwd: tmp });
    // Fake an origin pointing at ourselves and pin its HEAD.
    execFileSync("git", ["remote", "add", "origin", tmp], { cwd: tmp });
    execFileSync("git", ["fetch", "-q", "origin"], { cwd: tmp });
    execFileSync("git", ["symbolic-ref", `refs/remotes/origin/HEAD`,
      `refs/remotes/origin/${withOriginHead}`], { cwd: tmp });
  }
  return tmp;
}

test("DEFAULT_TARGET_BRANCH_FALLBACK is 'main'", () => {
  equal(DEFAULT_TARGET_BRANCH_FALLBACK, "main");
});

test("detectDefaultBranch returns origin HEAD when present", () => {
  const repo = freshRepo({ withOriginHead: "trunk" });
  try {
    equal(detectDefaultBranch(repo), "trunk");
  } finally { rmSync(repo, { recursive: true, force: true }); }
});

test("detectDefaultBranch falls back to init.defaultBranch", () => {
  const repo = freshRepo({ configDefault: "develop" });
  try {
    equal(detectDefaultBranch(repo), "develop");
  } finally { rmSync(repo, { recursive: true, force: true }); }
});

test("detectDefaultBranch falls back to DEFAULT_TARGET_BRANCH_FALLBACK on both lookups failing", () => {
  // Non-repo dir + suppressed git system/global config → both calls fail.
  const dir = mkdtempSync(join(tmpdir(), "pipeline-tb-nogit-"));
  const overrides = {
    HOME: dir,
    USERPROFILE: dir,
    GIT_CONFIG_GLOBAL: join(dir, "no-such-config"),
    GIT_CONFIG_NOSYSTEM: "1",
  };
  const saved = {};
  for (const [k, v] of Object.entries(overrides)) {
    saved[k] = process.env[k];
    process.env[k] = v;
  }
  try {
    equal(detectDefaultBranch(dir), DEFAULT_TARGET_BRANCH_FALLBACK);
  } finally {
    for (const k of Object.keys(overrides)) {
      if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k];
    }
    rmSync(dir, { recursive: true, force: true });
  }
});

// queue-plan precedence: --target-branch beats plan annotation beats detected default.
// Smoke-tested via the CLI; the precedence logic is small and lives in queue.mjs.
import { fileURLToPath } from "node:url";
const PIPELINE_BIN = join(fileURLToPath(new URL("..", import.meta.url)), "bin", "pipeline.mjs");

function runPipeline(args, { env = {}, cwd } = {}) {
  return spawnSync(process.execPath, [PIPELINE_BIN, ...args], {
    env: { ...process.env, ...env },
    cwd,
    stdio: ["ignore", "pipe", "pipe"],
    encoding: "utf8",
  });
}

test("queue-target-extract returns plan annotation when present", () => {
  const tmp = mkdtempSync(join(tmpdir(), "pipeline-tb-plan-"));
  const planPath = join(tmp, "plan.md");
  writeFileSync(planPath, "# plan\n\n*Target-Branch: develop*\n\n## Motivation\n");
  try {
    const r = runPipeline(["queue-target-extract", planPath]);
    equal(r.status, 0, r.stderr);
    match(r.stdout, /target=develop/);
  } finally { rmSync(tmp, { recursive: true, force: true }); }
});

test("queue-target-extract falls back to detectDefaultBranch when no annotation", () => {
  // Spawn pipeline in a synthesised repo whose origin HEAD is 'trunk', so the
  // detected default is deterministic and != 'master' — a regression that
  // re-introduces hardcoded "master" would fail this assertion.
  const repo = freshRepo({ withOriginHead: "trunk" });
  const planPath = join(repo, "plan.md");
  writeFileSync(planPath, "# plan\n\n## Motivation\n\nNo branch annotation.\n");
  try {
    const r = runPipeline(["queue-target-extract", planPath], { cwd: repo });
    equal(r.status, 0, r.stderr);
    match(r.stdout, /target=trunk\b/);
  } finally { rmSync(repo, { recursive: true, force: true }); }
});
