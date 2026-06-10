import { test } from "node:test";
import { equal, ok, deepEqual } from "node:assert/strict";
import { resolve } from "node:path";
import { homedir } from "node:os";
import { resolveTemplate, PLACEHOLDER_KEYS } from "../scripts/worktree-paths.mjs";

const PROJ = "/abs/projects/proj-a";
const CFG  = "/abs/.pipeline";

// ── 1. Substitution rules ───────────────────────────────────────────────────

test("resolveTemplate: known placeholders substituted", () => {
  const out = resolveTemplate("{root}/plans/{project}", {
    root: PROJ, project: "proj-a",
  }, { resolveBase: PROJ });
  equal(out, `${PROJ}/plans/proj-a`);
});

test("resolveTemplate: unknown placeholders pass through literally", () => {
  const out = resolveTemplate("{root}/{unknown_token}", { root: PROJ }, { resolveBase: PROJ });
  ok(out.endsWith("{unknown_token}"));
});

test("resolveTemplate: {config_dir} substituted from configDir option", () => {
  const out = resolveTemplate("{config_dir}/governor-template.md", {}, {
    resolveBase: CFG, configDir: CFG,
  });
  equal(out, `${CFG}/governor-template.md`);
});

// ── 2. Tilde expansion ──────────────────────────────────────────────────────

test("resolveTemplate: leading ~/ expands to homedir()", () => {
  const out = resolveTemplate("~/.pipeline/notifications", {}, { resolveBase: CFG });
  ok(out.startsWith(homedir()));
  ok(out.endsWith(".pipeline/notifications") || out.endsWith(".pipeline\\notifications"));
});

// ── 3. Absolute classification ──────────────────────────────────────────────

test("resolveTemplate: POSIX absolute paths returned as-is", () => {
  equal(resolveTemplate("/abs/dir", {}, { resolveBase: PROJ }), "/abs/dir");
});

test("resolveTemplate: Windows drive paths returned as-is", () => {
  const out = resolveTemplate("C:/Users/x/dir", {}, { resolveBase: PROJ });
  equal(out, "C:/Users/x/dir");
});

test("resolveTemplate: UNC paths returned as-is", () => {
  equal(resolveTemplate("\\\\server\\share\\dir", {}, { resolveBase: PROJ }), "\\\\server\\share\\dir");
});

// ── 4. Relative resolution against resolveBase ──────────────────────────────

test("resolveTemplate: relative path resolves against projectRoot category", () => {
  const out = resolveTemplate("plans", {}, { resolveBase: PROJ });
  equal(out, resolve(PROJ, "plans"));
});

test("resolveTemplate: relative path resolves against configDir category", () => {
  const out = resolveTemplate("hooks/x.mjs", {}, { resolveBase: CFG, configDir: CFG });
  equal(out, resolve(CFG, "hooks/x.mjs"));
});

test("resolveTemplate: relative path with placeholder substitutes then resolves", () => {
  const out = resolveTemplate("{project}/plans", { project: "proj-a" }, { resolveBase: PROJ });
  equal(out, resolve(PROJ, "proj-a/plans"));
});

// ── 5. Edge cases ───────────────────────────────────────────────────────────

test("resolveTemplate: null/undefined template returns null", () => {
  equal(resolveTemplate(null, {}, { resolveBase: PROJ }), null);
  equal(resolveTemplate(undefined, {}, { resolveBase: PROJ }), null);
});

test("resolveTemplate: empty template normalizes to null", () => {
  equal(resolveTemplate("", {}, { resolveBase: PROJ }), null);
});

test("resolveTemplate: missing resolveBase keeps relative path as-is", () => {
  equal(resolveTemplate("plans", {}, {}), "plans");
});

test("PLACEHOLDER_KEYS includes every documented vocabulary entry", () => {
  const expected = new Set([
    "root", "root_parent", "root_grandparent", "project",
    "feature", "kind", "branch", "branch_type", "branch_local", "config_dir",
  ]);
  deepEqual(new Set(PLACEHOLDER_KEYS), expected);
});

test("REFERENCE.md placeholder vocabulary table matches PLACEHOLDER_KEYS", async () => {
  const { readFileSync } = await import("node:fs");
  const { fileURLToPath } = await import("node:url");
  const here = fileURLToPath(new URL("./", import.meta.url));
  const md = readFileSync(`${here}../REFERENCE.md`, "utf8");
  const start = md.indexOf("### Placeholder vocabulary");
  ok(start >= 0, "Placeholder vocabulary section present");
  const after = md.indexOf("\n### ", start + 1);
  const section = md.slice(start, after >= 0 ? after : md.length);
  const tokens = new Set();
  for (const m of section.matchAll(/`\{([a-z_]+)\}`/g)) tokens.add(m[1]);
  deepEqual(tokens, new Set(PLACEHOLDER_KEYS));
});

// ── 6. Per-key end-to-end resolution ────────────────────────────────────────

test("end-to-end: plansDir (per-project) resolves under projectRoot", () => {
  const raw = "../CLAUDE/repos/{project}/plans";
  const out = resolveTemplate(raw, { project: "proj-a" }, { resolveBase: PROJ });
  equal(out, resolve(PROJ, "../CLAUDE/repos/proj-a/plans"));
});

test("end-to-end: notifications.fallback_dir (global) resolves under configDir", () => {
  const raw = "drops/{config_dir}-extras";  // contrived: shows {config_dir} interpolation
  const out = resolveTemplate(raw, {}, { resolveBase: CFG, configDir: CFG });
  equal(out, resolve(CFG, `drops/${CFG}-extras`));
});

test("end-to-end: governor.template_path (global) — ~/path expands and stays absolute", () => {
  const raw = "~/governor-template.md";
  const out = resolveTemplate(raw, {}, { resolveBase: CFG });
  ok(out.startsWith(homedir()));
  ok(out.endsWith("governor-template.md"));
});

test("end-to-end: governor.reports_dir (per-project) accepts {root}", () => {
  const raw = "{root}/reports";
  const out = resolveTemplate(raw, { root: PROJ }, { resolveBase: PROJ });
  equal(out, `${PROJ}/reports`);
});
