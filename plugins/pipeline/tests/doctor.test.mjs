// pipeline doctor — 11 checks, tristate output, exit-code policy.
//
// Focused per-check tests rather than end-to-end, so test results don't depend
// on the host's `claude` CLI presence.
import { test } from "node:test";
import { equal, ok, match } from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runDoctor, printDoctor, doctorExitCode } from "../src/setup/doctor.mjs";
import { connectUnified, close } from "../scripts/pipeline-db/connection.mjs";
import { projectAdd } from "../scripts/pipeline-db/projects.mjs";

function freshPaths() {
  const tmp = mkdtempSync(join(tmpdir(), "pipeline-doctor-"));
  return {
    tmp,
    paths: { stateDir: join(tmp, "state"), dataDir: join(tmp, "data") },
    cfgPath: join(tmp, "config.json"),
  };
}

function cleanup(tmp) {
  rmSync(tmp, { recursive: true, force: true });
}

function findCheck(results, label) {
  return results.find(r => r.label === label) ?? null;
}

test("doctor: returns exactly 16 results", async () => {
  // 15 prior checks + 1 added by phase 3b: worktree-layout-stale.
  const { tmp, paths, cfgPath } = freshPaths();
  try {
    const results = await runDoctor({ paths, configPath: cfgPath });
    equal(results.length, 16);
  } finally { cleanup(tmp); }
});

test("doctor: fresh install — DB absent, config absent → warns (not fails)", async () => {
  const { tmp, paths, cfgPath } = freshPaths();
  try {
    const results = await runDoctor({ paths, configPath: cfgPath });
    const db     = findCheck(results, "pipeline DB readable");
    const cfg    = findCheck(results, "config.json parseable");
    const slack  = findCheck(results, "Governance channel set");
    const proj   = findCheck(results, "at least one project");
    ok(db && !db.ok && db.warn, "DB check should warn");
    ok(cfg && !cfg.ok && cfg.warn, "config check should warn");
    ok(slack && !slack.ok && slack.warn, "Slack channel should warn (null default)");
    ok(proj && !proj.ok && proj.warn, "project count should warn (zero)");
  } finally { cleanup(tmp); }
});

test("doctor: malformed config.json → check 6 fails (exit 1)", async () => {
  const { tmp, paths, cfgPath } = freshPaths();
  try {
    writeFileSync(cfgPath, "{ not valid json", "utf8");
    const results = await runDoctor({ paths, configPath: cfgPath });
    const cfg = findCheck(results, "config.json parseable");
    ok(cfg && !cfg.ok && !cfg.warn, "config check should hard-fail");
    match(cfg.detail, /malformed/);
    equal(doctorExitCode(results), 1);
  } finally { cleanup(tmp); }
});

test("doctor: registered project at non-existent path → check 11 fails", async () => {
  const { tmp, paths, cfgPath } = freshPaths();
  try {
    const repoRoot = join(tmp, "ghostproj");
    mkdirSync(join(repoRoot, ".git"), { recursive: true });
    mkdirSync(paths.dataDir, { recursive: true });
    const db = connectUnified(paths);
    try {
      // Validation requires the path to exist at add-time. Add it, then
      // remove the directory underneath the registry to simulate a project
      // that was deleted/moved after registration.
      projectAdd(db, { name: "ghostproj", rootPath: repoRoot });
      rmSync(repoRoot, { recursive: true, force: true });
      const results = await runDoctor({ paths, configPath: cfgPath, db });
      const projPathsCheck = findCheck(results, "registered project paths");
      ok(projPathsCheck && !projPathsCheck.ok && !projPathsCheck.warn);
      match(projPathsCheck.detail, /not found/);
      equal(doctorExitCode(results), 1);
    } finally { close(db); }
  } finally { cleanup(tmp); }
});

test("doctor: registered project pointing at valid git repo → check 11 passes", async () => {
  const { tmp, paths, cfgPath } = freshPaths();
  try {
    const repoRoot = join(tmp, "myrepo");
    mkdirSync(join(repoRoot, ".git"), { recursive: true });
    mkdirSync(paths.dataDir, { recursive: true });
    const db = connectUnified(paths);
    try {
      projectAdd(db, { name: "myrepo", rootPath: repoRoot });
      const results = await runDoctor({ paths, configPath: cfgPath, db });
      const projPathsCheck = findCheck(results, "registered project paths");
      const projCountCheck = findCheck(results, "at least one project");
      ok(projPathsCheck && projPathsCheck.ok);
      ok(projCountCheck && projCountCheck.ok);
    } finally { close(db); }
  } finally { cleanup(tmp); }
});

test("doctor: Governance channel set + CLAUDE_SLACK_PLUGIN missing file → check 8 warns", async () => {
  const { tmp, paths, cfgPath } = freshPaths();
  const orig = process.env.CLAUDE_SLACK_PLUGIN;
  try {
    writeFileSync(cfgPath, JSON.stringify({ notifications: { slack_channel: "team-x" } }), "utf8");
    process.env.CLAUDE_SLACK_PLUGIN = join(tmp, "missing-plugin.mjs");
    const results = await runDoctor({ paths, configPath: cfgPath });
    const slack  = findCheck(results, "Governance channel set");
    const handler = findCheck(results, "claude-slack-plugin");
    ok(slack && slack.ok, "Slack channel should pass");
    ok(handler && !handler.ok && handler.warn, "claude-slack should warn (missing file)");
    match(handler.detail, /file missing/);
  } finally {
    if (orig === undefined) delete process.env.CLAUDE_SLACK_PLUGIN;
    else process.env.CLAUDE_SLACK_PLUGIN = orig;
    cleanup(tmp);
  }
});

test("doctor: Slack disabled → check 8 skipped (warns 'skipped — no Slack channel')", async () => {
  const { tmp, paths, cfgPath } = freshPaths();
  try {
    // No config → null slack_channel → check 8 should report 'skipped'
    const results = await runDoctor({ paths, configPath: cfgPath });
    const handler = findCheck(results, "claude-slack-plugin");
    ok(handler && !handler.ok && handler.warn);
    match(handler.detail, /skipped/);
  } finally { cleanup(tmp); }
});

test("doctorExitCode: warns only → 0", () => {
  const r = [
    { label: "a", ok: true,  warn: false, detail: "" },
    { label: "b", ok: false, warn: true,  detail: "" },
  ];
  equal(doctorExitCode(r), 0);
});

test("doctorExitCode: any hard fail → 1", () => {
  const r = [
    { label: "a", ok: true,  warn: false, detail: "" },
    { label: "b", ok: false, warn: false, detail: "" },
  ];
  equal(doctorExitCode(r), 1);
});

test("printDoctor: tristate icons match", () => {
  const calls = [];
  const origWrite = process.stdout.write.bind(process.stdout);
  process.stdout.write = (s) => { calls.push(s); return true; };
  try {
    printDoctor([
      { label: "alpha", ok: true,  warn: false, detail: "ok" },
      { label: "beta",  ok: false, warn: true,  detail: "warn" },
      { label: "gamma", ok: false, warn: false, detail: "fail" },
    ]);
  } finally {
    process.stdout.write = origWrite;
  }
  const out = calls.join("");
  match(out, /^✓ alpha: ok$/m);
  match(out, /^⚠ beta: warn$/m);
  match(out, /^✗ gamma: fail$/m);
});

test("doctor: paths missing throws clear error", async () => {
  try {
    await runDoctor({});
    throw new Error("expected throw");
  } catch (e) {
    match(e.message, /paths is required/);
  }
});
