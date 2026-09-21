// Test plan: repos/claude-plugin-marketplace/plans/codex-plugin-surface-test-plan.md
// Every row reads the REAL shipped manifest. A fixture proves nothing about what
// installs (#302: 1,380 green fixture tests missed a defect in the shipped artifact).
import { test } from "node:test";
import { equal, deepEqual, ok } from "node:assert/strict";
import { readFileSync, existsSync, statSync, mkdirSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";

const pluginRoot = new URL("..", import.meta.url); // plugins/swarm/
const codexDir = new URL(".codex-plugin/", pluginRoot);
const codexManifestURL = new URL("plugin.json", codexDir);
const claudeManifestURL = new URL(".claude-plugin/plugin.json", pluginRoot);

const readJson = (url) => JSON.parse(readFileSync(fileURLToPath(url), "utf8"));

function loadCodexManifest() {
  ok(
    existsSync(fileURLToPath(codexManifestURL)),
    "plugins/swarm/.codex-plugin/plugin.json does not exist — Codex has no manifest to install from",
  );
  return readJson(codexManifestURL);
}

// The three directories the packaging model forbids duplicating: one shared tree,
// one manifest per host. A second copy is the drift this whole plan exists to avoid.
const SHARED_DIRS = ["skills", "src", "tests"];
const duplicatedSharedDirs = () =>
  SHARED_DIRS.filter((name) => existsSync(fileURLToPath(new URL(`${name}/`, codexDir))));

test("the shipped .codex-plugin/plugin.json carries every field Codex reads", () => {
  const m = loadCodexManifest();

  for (const field of [
    "name", "version", "description", "author", "homepage",
    "repository", "license", "keywords", "skills", "interface",
  ]) {
    ok(m[field] !== undefined, `manifest is missing "${field}"`);
  }

  // name and version are the only two Codex requires.
  ok(typeof m.name === "string" && m.name.length > 0, "name must be a non-empty string");
  ok(typeof m.version === "string" && m.version.length > 0, "version must be a non-empty string");
  ok(Array.isArray(m.keywords) && m.keywords.length > 0, "keywords must be a non-empty array");

  // Shape, not emptiness: step 3 of the plan decides whether hooks gains entries.
  ok(m.hooks !== null && typeof m.hooks === "object" && !Array.isArray(m.hooks), "hooks must be an object");

  equal(m.interface.category, "Developer Tools");
  deepEqual(m.interface.capabilities, ["Interactive", "Read", "Write"]);
});

test("skills resolves to the shared plugins/swarm/skills/ tree, which exists on disk", () => {
  const m = loadCodexManifest();

  equal(m.skills, "./skills/", "skills must be the relative path into the shared tree, not a copy");
  const skillsDir = new URL(m.skills, pluginRoot);
  ok(statSync(fileURLToPath(skillsDir)).isDirectory(), `${m.skills} does not resolve to a directory`);
  ok(
    existsSync(fileURLToPath(new URL("swarm/SKILL.md", skillsDir))),
    "the shared skills/swarm/SKILL.md is not reachable through the manifest's skills path",
  );
});

test("the Codex manifest agrees with the Claude manifest on name, description and keywords", () => {
  const codex = loadCodexManifest();
  const claude = readJson(claudeManifestURL);

  equal(codex.name, claude.name);
  equal(codex.description, claude.description);
  deepEqual(codex.keywords, claude.keywords);

  // .claude-plugin/plugin.json declares no version, so package.json is this
  // plugin's only version source — this is the row that catches a release bump
  // landing in one file and missing the Codex sibling. If the Claude manifest
  // ever gains a version, it must match too.
  equal(codex.version, readJson(new URL("package.json", pluginRoot)).version);
  if (claude.version !== undefined) {
    equal(codex.version, claude.version, ".claude-plugin/plugin.json declares a version — the two must match");
  }
});

test("no root plugin.json exists — Codex reads .codex-plugin/plugin.json only", () => {
  // An absence check against a state that has never existed, so it passes today by
  // construction. Kept because the plan's earlier draft shipped exactly this file,
  // and it is one line to catch a regression to it.
  ok(
    !existsSync(fileURLToPath(new URL("plugin.json", pluginRoot))),
    "a root plugins/swarm/plugin.json exists — no host reads it; the manifest belongs in .codex-plugin/",
  );
});

test("no skills/, src/ or tests/ is duplicated under .codex-plugin/", () => {
  // The bare assertion is decorative: none of these has ever existed, so it passes
  // without the packaging model being right. Plant one, prove the check reports it,
  // remove it, prove the shipped tree is clean — both states in one run.
  const planted = fileURLToPath(new URL("src/", codexDir));
  // Never remove a directory the test did not create: blind cleanup would delete a
  // genuinely duplicated src/ and then report the tree clean.
  const preexisting = existsSync(planted);
  mkdirSync(planted, { recursive: true });
  let detected;
  try {
    detected = duplicatedSharedDirs();
  } finally {
    if (!preexisting) rmSync(planted, { recursive: true, force: true });
  }

  deepEqual(
    detected,
    ["src"],
    "a planted .codex-plugin/src/ was not detected — this row cannot fail on the duplication it names",
  );
  deepEqual(duplicatedSharedDirs(), [], "the shipped tree duplicates a shared directory under .codex-plugin/");
});
