import { test } from "node:test";
import { ok } from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(fileURLToPath(import.meta.url), "..", "..", "..", "..");
const refs = join(root, "plugins", "swarm", "skills", "swarm", "references");

const read = (name) => readFileSync(join(refs, name), "utf8");

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

test("SKILL.md scopes the dispatch-gate promise to the host that enforces it", () => {
  const skill = readFileSync(
    join(root, "plugins", "swarm", "skills", "swarm", "SKILL.md"),
    "utf8",
  );

  // The gate is a Claude Code PreToolUse hook; the Codex manifest declares none, so
  // an unscoped "the dispatch gate denies a run" promises Codex enforcement it lacks.
  const claim = skill.split(/\n\s*\n/).find((p) => p.includes("dispatch gate denies"));
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
