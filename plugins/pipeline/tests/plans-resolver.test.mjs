import { test } from "node:test";
import assert from "node:assert/strict";
import { homedir, tmpdir } from "node:os";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { resolvePlansDir, resolvePlanFile } from "../src/plans-resolver.mjs";

const ROOT = "C:/code/myproj";
const PARENT = dirname(ROOT);
const GRAND = dirname(PARENT);

test("default fallback: cfg.plansDir unset → <projectRoot>/plans", () => {
  const out = resolvePlansDir({
    project: "myproj",
    projectRoot: ROOT,
    _config: {},
  });
  assert.equal(out, resolve(ROOT, "plans"));
});

test("relative cfg.plansDir resolves against projectRoot", () => {
  const out = resolvePlansDir({
    project: "myproj",
    projectRoot: ROOT,
    _config: { plansDir: "../shared-plans" },
  });
  assert.equal(out, resolve(ROOT, "../shared-plans"));
});

test("absolute cfg.plansDir passes through", () => {
  const abs = process.platform === "win32" ? "D:/elsewhere/plans" : "/elsewhere/plans";
  const out = resolvePlansDir({
    project: "myproj",
    projectRoot: ROOT,
    _config: { plansDir: abs },
  });
  assert.equal(out.replaceAll("\\", "/"), abs);
});

test("{project} placeholder substitutes", () => {
  const out = resolvePlansDir({
    project: "myproj",
    projectRoot: ROOT,
    _config: { plansDir: "../CLAUDE/repos/{project}/plans" },
  });
  assert.equal(out, resolve(ROOT, "../CLAUDE/repos/myproj/plans"));
});

test("{root_parent} placeholder substitutes", () => {
  const out = resolvePlansDir({
    project: "myproj",
    projectRoot: ROOT,
    _config: { plansDir: "{root_parent}/shared-plans" },
  });
  assert.equal(out.replaceAll("\\", "/"), PARENT + "/shared-plans");
});

test("{root_grandparent} placeholder substitutes", () => {
  const out = resolvePlansDir({
    project: "myproj",
    projectRoot: ROOT,
    _config: { plansDir: "{root_grandparent}/repo-set/{project}/plans" },
  });
  assert.equal(out.replaceAll("\\", "/"), GRAND + "/repo-set/myproj/plans");
});

test("leading ~/ expands to homedir", () => {
  const out = resolvePlansDir({
    project: "myproj",
    projectRoot: ROOT,
    _config: { plansDir: "~/work/plans/{project}" },
  });
  assert.equal(out.replaceAll("\\", "/"), `${homedir().replaceAll("\\", "/")}/work/plans/myproj`);
});

test("project-row plans_dir overrides cfg.plansDir", () => {
  const override = process.platform === "win32" ? "E:/override/plans" : "/override/plans";
  const out = resolvePlansDir({
    project: "myproj",
    projectRoot: ROOT,
    projectPlansDir: override,
    _config: { plansDir: "{root_parent}/shared-plans" },
  });
  assert.equal(out, override);
});

test("project name falls back to basename(projectRoot)", () => {
  const out = resolvePlansDir({
    projectRoot: ROOT,
    _config: { plansDir: "../CLAUDE/repos/{project}/plans" },
  });
  assert.equal(out, resolve(ROOT, "../CLAUDE/repos/myproj/plans"));
});

test("unknown placeholders render literally (not silently dropped)", () => {
  const out = resolvePlansDir({
    project: "myproj",
    projectRoot: ROOT,
    _config: { plansDir: "{projetc}/plans" },
  });
  assert.ok(out.includes("{projetc}"), `expected literal {projetc} in output: ${out}`);
});

// ── parity vs. the (now-deleted) duplicated impls ──────────────────────────
test("parity: bare 'plans'", () => {
  const out = resolvePlansDir({ project: "p", projectRoot: ROOT, _config: { plansDir: "plans" } });
  assert.equal(out, resolve(ROOT, "plans"));
});

test("parity: '{project}/plans'", () => {
  const out = resolvePlansDir({ project: "p", projectRoot: ROOT, _config: { plansDir: "{project}/plans" } });
  assert.equal(out, resolve(ROOT, "p/plans"));
});

// ── resolvePlanFile ────────────────────────────────────────────────────────
test("resolvePlanFile: absolute path passes through", () => {
  const abs = process.platform === "win32" ? "D:/x/plan.md" : "/x/plan.md";
  assert.equal(resolvePlanFile(abs, { projectRoot: ROOT }), abs);
});

test("resolvePlanFile: bare filename joins under plans dir", () => {
  const out = resolvePlanFile("feature-x.md", { project: "myproj", projectRoot: ROOT, _config: { plansDir: "plans" } });
  assert.equal(out, join(resolve(ROOT, "plans"), "feature-x.md"));
});

test("resolvePlanFile: honours cfg.plansDir template", () => {
  const out = resolvePlanFile("feature-x.md", {
    project: "myproj",
    projectRoot: ROOT,
    _config: { plansDir: "../CLAUDE/repos/{project}/plans" },
  });
  assert.equal(out, join(resolve(ROOT, "../CLAUDE/repos/myproj/plans"), "feature-x.md"));
});

// ── end-to-end: session-gen sees the right plan via cfg.plansDir ───────────
test("session-gen: cfg.plansDir = '../shared/plans' picks up plan from sibling dir", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "plans-resolver-e2e-"));
  try {
    const projectRoot = join(tmp, "proj");
    const sharedPlans = join(tmp, "shared", "plans");
    mkdirSync(projectRoot, { recursive: true });
    mkdirSync(sharedPlans, { recursive: true });
    writeFileSync(join(sharedPlans, "demo-feat.md"), "# demo content body\n");

    const { generateSessionFile } = await import("../src/session-gen.mjs");
    const out = generateSessionFile("proj", "demo-feat.md", "dev", {
      projectRoot,
      _cfg: { plansDir: "../shared/plans" },
    });
    const content = await import("node:fs").then(m => m.readFileSync(out, "utf8"));
    assert.ok(content.includes("# demo content body"),
      "session file should embed plan content from cfg.plansDir-resolved location");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});
