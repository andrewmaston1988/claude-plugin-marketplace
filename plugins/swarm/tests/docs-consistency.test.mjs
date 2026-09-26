import { test } from "node:test";
import { ok } from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(fileURLToPath(import.meta.url), "..", "..", "..", "..");
const refs = join(root, "plugins", "swarm", "skills", "swarm", "references");

const read = (name) => readFileSync(join(refs, name), "utf8");
const skill = () => readFileSync(join(root, "plugins", "swarm", "skills", "swarm", "SKILL.md"), "utf8");

test("swarm reference docs do not restate roster token arithmetic", () => {
  const roster = read("reading-the-roster.md");

  // Two needles, because one only catches the phrasing that was deleted: any
  // restatement of which buckets the column sums is the drift this forbids.
  ok(
    !roster.includes("tokenTotal"),
    "reading-the-roster.md must not name tokenTotal — which buckets it sums is the command's business, not the doc's",
  );
  ok(
    !/input\s*\+\s*output\s*\+\s*cacheCreation/.test(roster),
    "reading-the-roster.md must not restate the token bucket arithmetic",
  );
});

// R8: item 14 ships every provider disabled until setup writes the roots, so an
// unconfigured install refuses everything. The check has to be the FIRST thing in the
// skill, before the prose that assumes a configured engine.
test("SKILL.md opens with the unconfigured check, before anything else", () => {
  const text = skill();
  const setupArg = text.split("\n").findIndex((l) => l.trimStart().startsWith("**`setup`**"));
  ok(setupArg > -1, "SKILL.md must keep its `setup` argument line");
  // Everything from the argument line to the next section heading is the opening.
  const after = text.split("\n").slice(setupArg + 1).join("\n").split(/\n## /)[0];
  const check = after.split(/\n\s*\n/).find((p) => p.trim());
  ok(check, "SKILL.md must carry a check straight after the `setup` argument line");
  ok(check.includes("config.json"), `the check must name the missing file; got: ${check}`);
  ok(check.includes("allowedRoots"), `the check must name the empty-roots case; got: ${check}`);
  ok(check.includes("references/setup.md"), `the check must route to the setup reference; got: ${check}`);
});

test("SKILL.md scopes the dispatch-gate promise to the host that enforces it", () => {
  const text = skill();

  // The gate is a Claude Code PreToolUse hook; the Codex manifest declares none, so
  // an unscoped "the dispatch gate denies a run" promises Codex enforcement it lacks.
  const claim = text.split(/\n\s*\n/).find((p) => p.includes("dispatch gate denies"));
  ok(claim, "SKILL.md must state what the dispatch gate enforces");
  ok(claim.includes("Claude Code"), `the gate promise must name its host scope; got: ${claim}`);
  ok(claim.includes("Codex"), `the gate promise must name a Codex host's containment; got: ${claim}`);
});

test("swarm reference docs keep the guidance no command prints", () => {
  const roster = read("reading-the-roster.md");
  const modelSelection = read("model-selection.md");

  const required = [
    ["reading-the-roster.md", roster, "⚠ quiet"],
    // Each state tag on its own line, so deleting one bites rather than sliding
    // past a surviving "States:" prefix.
    ["reading-the-roster.md", roster, "`failed`"],
    ["reading-the-roster.md", roster, "`rate-limited`"],
    ["reading-the-roster.md", roster, "`quota`"],
    ["reading-the-roster.md", roster, "`retrying`"],
    ["reading-the-roster.md", roster, "`blocked`"],
    ["reading-the-roster.md", roster, "There is no per-leaf kill."],
    ["reading-the-roster.md", roster, "Pathological leaves are real"],
    ["reading-the-roster.md", roster, "Red flags — you are about to interfere with a healthy run"],
    ["reading-the-roster.md", roster, "A leaf ended and produced no commit — recover, never kill"],
    // The recovery procedure is pinned by its body, not just its heading and date.
    ["reading-the-roster.md", roster, "2026-07-15"],
    ["reading-the-roster.md", roster, "re-dispatch a FRESH manifest name"],
    ["reading-the-roster.md", roster, "Rationalisations that preceded the real incident"],
    ["reading-the-roster.md", roster, "`costUsd`"],
    ["reading-the-roster.md", roster, "The activity cell"],
    ["reading-the-roster.md", roster, "One leaf far slower than its siblings"],
    ["model-selection.md", modelSelection, "The seating rule is the method, not a list:"],
    ["model-selection.md", modelSelection, "manifest preview in the offer gate"],
    ["model-selection.md", modelSelection, "~+45% cost"],
    ["model-selection.md", modelSelection, "Anti-patterns to refuse"],
    ["model-selection.md", modelSelection, "cost lives on the Anthropic subscription"],
  ];

  for (const [file, content, needle] of required) {
    ok(content.includes(needle), `${file} must keep: ${needle}`);
  }
});
