// queue-plan --title: an operator can set the PR title at queue time without
// editing the plan. The flag wins over the plan's *Title:* annotation; with
// neither, pr_title stays null and merge falls back to the feature slug. Drives
// the real CLI against a throwaway project under a tmp HOME (so ~/.pipeline is
// never touched), mirroring the parity runner's setup.
import { test } from "node:test";
import { equal } from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { connectPath, close } from "../scripts/pipeline-db/connection.mjs";
import { projectAdd } from "../scripts/pipeline-db/projects.mjs";

const PLUGIN  = dirname(dirname(fileURLToPath(import.meta.url)));
const BIN     = join(PLUGIN, "bin", "pipeline.mjs");
const PROJECT = "testproject";
const FEATURE = "my-feature";

const PLAN_NO_TITLE   = `# My Feature\n\n*Branch: \`autonomous/${FEATURE}\`*\n\n## Plan\nDo the thing.\n`;
const PLAN_WITH_TITLE = `# My Feature\n\n*Branch: \`autonomous/${FEATURE}\`*\n*Title:* Annotation Title\n\n## Plan\nDo the thing.\n`;

// Queue a plan via the real CLI against a fresh project; return the row JSON.
function queue(planBody, extraArgs) {
  const tmp = mkdtempSync(join(tmpdir(), "queue-title-"));
  try {
    const repo = join(tmp, "repo");
    mkdirSync(join(repo, "plans"), { recursive: true });
    spawnSync("git", ["init", "--quiet"], { cwd: repo, stdio: "ignore" });
    writeFileSync(join(repo, "plans", FEATURE + ".md"), planBody);

    // Use XDG-aware paths matching getPaths() on each platform.
    const isLinux = process.platform === "linux";
    const stateDir = isLinux ? join(tmp, ".local", "state", "pipeline") : join(tmp, ".pipeline");
    const xdgEnv = isLinux ? {
      XDG_CONFIG_HOME: join(tmp, ".config"),
      XDG_DATA_HOME: join(tmp, ".local", "share"),
      XDG_STATE_HOME: join(tmp, ".local", "state"),
    } : {};
    mkdirSync(stateDir, { recursive: true });
    const dbPath = join(stateDir, "pipeline.db");
    const db = connectPath(dbPath);
    try { projectAdd(db, { name: PROJECT, rootPath: repo }); } finally { close(db); }

    const env = { ...process.env, HOME: tmp, USERPROFILE: tmp, ...xdgEnv };
    const r = spawnSync(
      process.execPath,
      [BIN, "queue-plan", PROJECT, FEATURE, "--target-branch", "main", ...extraArgs],
      { env, cwd: PLUGIN, stdio: "pipe", timeout: 15000 },
    );
    equal(r.status, 0, `queue-plan exited ${r.status}: ${r.stderr?.toString()}`);
    return JSON.parse(r.stdout.toString().trim());
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

test("--title sets pr_title when the plan has no annotation", () => {
  equal(queue(PLAN_NO_TITLE, ["--title", "Custom PR Title"]).pr_title, "Custom PR Title");
});

test("--title overrides the plan's *Title:* annotation", () => {
  equal(queue(PLAN_WITH_TITLE, ["--title", "Flag Wins"]).pr_title, "Flag Wins");
});

test("without --title, pr_title falls back to the *Title:* annotation", () => {
  equal(queue(PLAN_WITH_TITLE, []).pr_title, "Annotation Title");
});

test("with neither --title nor annotation, pr_title is null (merge uses the slug)", () => {
  equal(queue(PLAN_NO_TITLE, []).pr_title, null);
});
