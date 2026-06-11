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
import { generateSessionFile } from "../scripts/session-gen.mjs";

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
