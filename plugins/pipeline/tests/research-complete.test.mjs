// research-complete — stored plan paths must be absolute: the orchestrator
// reads plan_file verbatim at spawn time, so a bare filename parks the row
// at manual with [plan-file-missing]. Pins the resolve + fail-fast behaviour.
import { test } from "node:test";
import { equal, ok, match } from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { connectPath, close, projectAdd, rowAdd, rowGet } from "../scripts/pipeline-db/index.mjs";

const _here   = dirname(fileURLToPath(import.meta.url));
const PLUGIN  = dirname(_here);
const BIN     = join(PLUGIN, "bin", "pipeline.mjs");
const PROJECT = "testproject";

function setup() {
  const tmp  = mkdtempSync(join(tmpdir(), "research-complete-"));
  const repo = join(tmp, "repo");
  mkdirSync(join(repo, ".git"), { recursive: true });
  // On Linux getPaths() uses XDG — point XDG_DATA_HOME into tmp so the
  // subprocess opens the same DB that this process creates here.
  const xdgData = join(tmp, ".local", "share");
  const dbPath  = process.platform === "linux"
    ? join(xdgData, "pipeline", "pipeline.db")
    : join(tmp, ".pipeline", "pipeline.db");
  const db = connectPath(dbPath);
  projectAdd(db, { name: PROJECT, rootPath: repo });
  rowAdd(db, PROJECT, {
    feature: "feat-research",
    planFile: join(repo, "plans", "feat-research.md"),
    stage: "research",
  });
  close(db);
  const env = { ...process.env, HOME: tmp, USERPROFILE: tmp, XDG_DATA_HOME: xdgData };
  return { tmp, repo, dbPath, env };
}

function teardown(tmp) {
  rmSync(tmp, { recursive: true, force: true });
}

function run(env, argv) {
  return spawnSync(process.execPath, [BIN, ...argv], {
    env, cwd: PLUGIN, stdio: "pipe", timeout: 15000,
  });
}

function getRow(dbPath, feature) {
  const db = connectPath(dbPath);
  try { return rowGet(db, PROJECT, feature); } finally { close(db); }
}

test("research-complete: bare filename is resolved and stored absolute", () => {
  const { tmp, repo, dbPath, env } = setup();
  try {
    const plansDir = join(repo, "plans");
    mkdirSync(plansDir, { recursive: true });
    writeFileSync(join(plansDir, "feat-dev.md"), "# feat-dev\n");

    const r = run(env, ["research-complete", PROJECT, "feat-research", "feat-dev", "feat-dev.md"]);
    equal(r.status, 0, `exit 0, stderr: ${r.stderr}`);

    const dev = getRow(dbPath, "feat-dev");
    ok(dev, "dev row created");
    equal(dev.plan_file, join(plansDir, "feat-dev.md"), "plan_file stored absolute");
    equal(dev.stage, "queued");
    equal(getRow(dbPath, "feat-research").stage, "done");
  } finally { teardown(tmp); }
});

test("research-complete: absolute plan path passes through verbatim", () => {
  const { tmp, repo, dbPath, env } = setup();
  try {
    const plansDir = join(repo, "plans");
    mkdirSync(plansDir, { recursive: true });
    const abs = join(plansDir, "feat-dev.md");
    writeFileSync(abs, "# feat-dev\n");

    const r = run(env, ["research-complete", PROJECT, "feat-research", "feat-dev", abs]);
    equal(r.status, 0, `exit 0, stderr: ${r.stderr}`);
    equal(getRow(dbPath, "feat-dev").plan_file, abs);
  } finally { teardown(tmp); }
});

test("research-complete: missing dev plan fails without touching rows", () => {
  const { tmp, dbPath, env } = setup();
  try {
    const r = run(env, ["research-complete", PROJECT, "feat-research", "feat-dev", "feat-dev.md"]);
    equal(r.status, 1, "exits non-zero");
    match(r.stderr.toString(), /dev plan file not found/);
    equal(getRow(dbPath, "feat-dev"), null, "no dev row created");
    equal(getRow(dbPath, "feat-research").stage, "research", "research row untouched");
  } finally { teardown(tmp); }
});
