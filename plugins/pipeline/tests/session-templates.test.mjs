// plugin-owned session templates + placeholder expansion.
//
// Covers session-gen.mjs against the bundled dev/review/research/test/governor
// templates plus operator override behaviour with per-file fallback.
import { test } from "node:test";
import { equal, match, ok, throws } from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync, readFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { generateSessionFile, resolveSessionFile } from "../scripts/session-gen.mjs";
import { featureWorktreePath } from "../scripts/worktree-paths.mjs";

const SPAWN_MJS_PATH = fileURLToPath(new URL("../scripts/orchestrator/spawn.mjs", import.meta.url));

function withTempProject(planContent, fn) {
  const root = mkdtempSync(join(tmpdir(), "pipeline-session-gen-"));
  const plansDir = join(root, "plans");
  mkdirSync(plansDir, { recursive: true });
  const planPath = join(plansDir, "feat-x.md");
  writeFileSync(planPath, planContent, "utf8");
  try { return fn(root, planPath); }
  finally { rmSync(root, { recursive: true, force: true }); }
}

test("generateSessionFile: dev template expands core placeholders + plan content", () => {
  withTempProject("# Plan body\n\nLine two.\n", (root) => {
    const out = generateSessionFile("myproj", "feat-x", "dev", {
      projectRoot: root,
      _cfg: { review: { skill: "/code-review", deep_flag: "" } },
    });
    const content = readFileSync(out, "utf8");
    match(content, /# Dev Session — feat-x/);
    match(content, /Project: `myproj`/);
    match(content, /# Plan body/);
    match(content, /Line two\./);
    // Correlation ID is the orchestrator's per-spawn env var (literal $CORRELATION_ID
    // in the rendered template — bash expands it at session runtime). Previously
    // this was the static session slug; that caused progress-slug collisions
    // between two dev attempts on the same plan within a day.
    match(content, /Correlation ID: `\$CORRELATION_ID`/);
  });
});

test("generateSessionFile: review template substitutes REVIEW_SKILL from config", () => {
  withTempProject("plan body", (root) => {
    const out = generateSessionFile("p", "feat-x", "review", {
      projectRoot: root,
      _cfg: { review: { skill: "/code-review", deep_flag: "--example-flag" } },
    });
    const content = readFileSync(out, "utf8");
    match(content, /\/code-review --example-flag/);
    // Plain `{{REVIEW_SKILL}}` placeholder should be fully consumed
    ok(!content.includes("{{REVIEW_SKILL}}"));
  });
});

test("generateSessionFile: missing projectRoot throws", () => {
  throws(
    () => generateSessionFile("p", "feat-x", "dev", { _cfg: {} }),
    /projectRoot is required/
  );
});

test("generateSessionFile: writes session file to <projectRoot>/sessions/", () => {
  withTempProject("plan", (root) => {
    const out = generateSessionFile("p", "feat-x", "dev", {
      projectRoot: root, _cfg: {},
    });
    ok(out.includes(`${join(root, "sessions")}`));
    ok(existsSync(out));
    ok(out.endsWith(".md"));
  });
});

test("generateSessionFile: override session_templates_dir takes precedence", () => {
  withTempProject("plan", (root) => {
    const overrideDir = mkdtempSync(join(tmpdir(), "pipeline-tmpl-"));
    writeFileSync(
      join(overrideDir, "dev-session.md"),
      "OVERRIDE for {{FEATURE}} in {{PROJECT}}\n",
      "utf8"
    );
    try {
      const out = generateSessionFile("p", "feat-x", "dev", {
        projectRoot: root,
        _cfg: { session_templates_dir: overrideDir, review: {} },
      });
      const content = readFileSync(out, "utf8");
      match(content, /^OVERRIDE for feat-x in p$/m);
      // Bundled dev-session.md content should NOT appear
      ok(!content.includes("# Dev Session — feat-x"));
    } finally {
      rmSync(overrideDir, { recursive: true, force: true });
    }
  });
});

test("generateSessionFile: override with missing template falls back to bundled per-file", () => {
  withTempProject("plan", (root) => {
    const overrideDir = mkdtempSync(join(tmpdir(), "pipeline-tmpl-partial-"));
    // Override has dev only — review must fall back to bundled
    writeFileSync(join(overrideDir, "dev-session.md"), "OVERRIDE dev\n", "utf8");
    try {
      const devOut = generateSessionFile("p", "feat-x", "dev", {
        projectRoot: root,
        _cfg: { session_templates_dir: overrideDir, review: {} },
      });
      const reviewOut = generateSessionFile("p", "feat-x", "review", {
        projectRoot: root,
        _cfg: { session_templates_dir: overrideDir, review: {} },
      });
      const devContent    = readFileSync(devOut,    "utf8");
      const reviewContent = readFileSync(reviewOut, "utf8");
      match(devContent,    /^OVERRIDE dev$/m);
      match(reviewContent, /# Review Session — feat-x/);
    } finally {
      rmSync(overrideDir, { recursive: true, force: true });
    }
  });
});

test("generateSessionFile: plan file with absolute path is read directly", () => {
  withTempProject("plan content", (root, planPath) => {
    const out = generateSessionFile("p", planPath, "dev", {
      projectRoot: root, _cfg: {},
    });
    const content = readFileSync(out, "utf8");
    match(content, /plan content/);
  });
});

test("spawn prompt no longer references 'Resume Instructions'", () => {
  const src = readFileSync(SPAWN_MJS_PATH, "utf8");
  ok(!src.includes("Resume Instructions"));
  ok(src.includes("execute the session"));
});

test("five session templates are bundled with the plugin", () => {
  const dir = fileURLToPath(new URL("../templates", import.meta.url));
  for (const name of ["dev", "review", "test", "research", "governor"]) {
    ok(existsSync(join(dir, `${name}-session.md`)), `missing ${name}-session.md`);
  }
});

test("resolveSessionFile: row.branch flows into {{BRANCH}}", () => {
  withTempProject("# Plan body\n", (root, planPath) => {
    const row = { feature: "feat-x", plan: planPath, notes: "type=dev",
                  branch: "anm/custom_x", target_branch: "main" };
    const out = resolveSessionFile(row, "p", { projectRoot: root });
    const content = readFileSync(out, "utf8");
    match(content, /Branch: `anm\/custom_x`/);
  });
});

// resolveSessionFile must filter notes-mentioned session files by the intended
// session-type prefix. Real-world trigger: a dev row's notes accumulated a
// stale `sessions/review-…md` from a prior review attempt; the unfiltered code
// picked that file when spawning a dev session, so the model ran review
// content while the orchestrator advanced the row as a dev spawn — the reaper
// then burned a review retry recovering it.
test("resolveSessionFile: notes-mentioned .md filtered by stageSessionType prefix", () => {
  withTempProject("# Plan body\n", (root, planPath) => {
    const sessionsDir = join(root, "sessions");
    mkdirSync(sessionsDir, { recursive: true });
    // Both files exist on disk; only the dev-prefixed one should be picked
    // when the spawn is for a dev session.
    const reviewSession = join(sessionsDir, "review-2026-06-17-feat-x.md");
    const devSession    = join(sessionsDir, "dev-2026-06-17-feat-x.md");
    writeFileSync(reviewSession, "stale review session content", "utf8");
    writeFileSync(devSession,    "fresh dev session content",    "utf8");

    const row = {
      feature: "feat-x",
      plan: planPath,
      notes: "type=dev sessions/review-2026-06-17-feat-x.md sessions/dev-2026-06-17-feat-x.md",
      branch: "autonomous/feat-x",
      target_branch: "main",
    };
    const out = resolveSessionFile(row, "p", { projectRoot: root, stageSessionType: "dev" });
    equal(out, devSession, "dev spawn must reuse dev-prefixed notes path, not stale review file");
  });
});

test("resolveSessionFile: wrong-type notes .md falls through to fresh template", () => {
  withTempProject("# Plan body\n", (root, planPath) => {
    const sessionsDir = join(root, "sessions");
    mkdirSync(sessionsDir, { recursive: true });
    // Only a wrong-type session file exists in notes. A dev spawn must NOT
    // reuse it — it must generate a fresh dev session.
    const reviewSession = join(sessionsDir, "review-2026-06-17-feat-x.md");
    writeFileSync(reviewSession, "stale review session content", "utf8");

    const row = {
      feature: "feat-x",
      plan: planPath,
      notes: "type=dev sessions/review-2026-06-17-feat-x.md",
      branch: "autonomous/feat-x",
      target_branch: "main",
    };
    const out = resolveSessionFile(row, "p", {
      projectRoot: root, stageSessionType: "dev", _cfg: { review: {} },
    });
    ok(out !== reviewSession, "must not reuse wrong-type session file");
    match(out, /[\\/]sessions[\\/]dev-/, "generated path must be a dev-* session");
  });
});

test("resolveSessionFile: no session-type hint anywhere → notes path skipped", () => {
  withTempProject("# Plan body\n", (root, planPath) => {
    const sessionsDir = join(root, "sessions");
    mkdirSync(sessionsDir, { recursive: true });
    const reviewSession = join(sessionsDir, "review-2026-06-17-feat-x.md");
    writeFileSync(reviewSession, "stale review", "utf8");

    // No stageSessionType opt + notes lacks `type=…` token — the prefix is
    // null, so the notes path must be skipped rather than coerced into a
    // bogus String(null).startsWith() check.
    const row = {
      feature: "feat-x",
      plan: planPath,
      notes: "sessions/review-2026-06-17-feat-x.md",
      branch: "autonomous/feat-x",
      target_branch: "main",
    };
    const out = resolveSessionFile(row, "p", { projectRoot: root, dry: true });
    equal(out, null, "dry resolve with null sTypePrefix must skip notes path and return null");
  });
});

test("resolveSessionFile: blank branch defaults to autonomous/<feature>", () => {
  withTempProject("# Plan body\n", (root, planPath) => {
    const row = { feature: "feat-x", plan: planPath, notes: "type=dev",
                  branch: "—", target_branch: "main" };
    const out = resolveSessionFile(row, "p", { projectRoot: root });
    const content = readFileSync(out, "utf8");
    match(content, /Branch: `autonomous\/feat-x`/);
  });
});

test("dev template guard checks {{BRANCH}}, no hardcoded autonomous/<feature>", () => {
  withTempProject("# Plan\n", (root) => {
    const out = generateSessionFile("p", "feat-x", "dev", {
      projectRoot: root, branch: "anm/custom_x", _cfg: { review: {} },
    });
    const content = readFileSync(out, "utf8");
    match(content, /must output: anm\/custom_x/);
    ok(!content.includes("autonomous/feat-x"), "no hardcoded autonomous/<feature> should remain");
  });
});

test("review template uses {{BRANCH}} for verify/checkout", () => {
  withTempProject("# Plan\n", (root) => {
    const out = generateSessionFile("p", "feat-x", "review", {
      projectRoot: root, branch: "anm/custom_x", _cfg: { review: {} },
    });
    const content = readFileSync(out, "utf8");
    match(content, /anm\/custom_x/);
    ok(!content.includes("autonomous/feat-x"));
  });
});

test("test template checkout returns to {{BRANCH}}", () => {
  withTempProject("# Plan\n", (root) => {
    const out = generateSessionFile("p", "feat-x", "test", {
      projectRoot: root, branch: "anm/custom_x", _cfg: { review: {} },
    });
    const content = readFileSync(out, "utf8");
    match(content, /git checkout anm\/custom_x/);
    ok(!content.includes("autonomous/feat-x"));
  });
});

// [REGRESSION] session CWD uses per-feature worktree, not deprecated branch-based.
// The spawn path in scripts/orchestrator/index.mjs was routing through
// orchestratorWorktreePath (deprecated phase-2 template
// {branch_type}-{branch_local}), which re-shared worktrees across branches and
// broke per-feature isolation. It must call featureWorktreePath so every
// session lands in {root_parent}/.worktrees/{project}/{feature}/.
test("orchestrator spawn-path routes session cwd through featureWorktreePath, not deprecated branch template", () => {
  const src = readFileSync(
    fileURLToPath(new URL("../scripts/orchestrator/index.mjs", import.meta.url)),
    "utf8"
  );
  // Must not import the deprecated function.
  ok(!/from\s+["'][^"']*worktree-paths\.mjs["'][^;]*orchestratorWorktreePath/.test(src),
    "orchestrator/index.mjs must not import orchestratorWorktreePath on the spawn path");
  // Must not call the deprecated function (a comment mention is fine).
  ok(!/[^/]orchestratorWorktreePath\s*\(/.test(src),
    "orchestrator/index.mjs must not call orchestratorWorktreePath on the spawn path");
  // Must use featureWorktreePath keyed on row.feature for the per-session cwd.
  match(src, /featureWorktreePath\s*\(\s*\{[\s\S]*?feature\s*:\s*row\.feature/);

  // End-to-end: the cwd the orchestrator hands to resolveSessionFile should
  // be the per-feature worktree path. resolveSessionFile forwards `cwd` into
  // {{CWD}} in the rendered session template, so we can read it back from
  // the "Working directory:" header.
  withTempProject("# Plan\n", (root, planPath) => {
    const row = { feature: "feat-x", plan: planPath, notes: "type=dev",
                  branch: "autonomous/feat-x", target_branch: "main" };
    // Mirrors what the orchestrator computes at spawn time after the fix.
    const cwd = featureWorktreePath({ project: "p", projectRoot: root, feature: "feat-x" });
    const out = resolveSessionFile(row, "p", { projectRoot: root, cwd });
    const content = readFileSync(out, "utf8");
    match(content, new RegExp(`Working directory: \`${cwd.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\``));
    // And the deprecated {branch_type}-{branch_local} shape must not appear.
    ok(!content.includes("autonomous-feat-x"),
      "session cwd must not embed deprecated {branch_type}-{branch_local} path");
  });
});
