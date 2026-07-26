import { test } from "node:test";
import { equal, ok, match } from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  onboardingCost,
  encodeProjectDir,
  contextWindowFor,
} from "../skills/orchestrating-agents/scripts/onboarding-cost.mjs";

// ---- structural-test helpers (T1–T11) ----

const SKILLS_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "skills");
const NEW_SKILL = join(SKILLS_DIR, "orchestrating-agents", "SKILL.md");
const SWARM_SKILL = join(SKILLS_DIR, "swarm", "SKILL.md");

const read = (p) => readFileSync(p, "utf8");

// Slice a `## `-level section (heading line through the line before the next `## `).
function sectionSlice(content, headingText) {
  const lines = content.split("\n");
  const start = lines.findIndex((l) => l.trim() === headingText);
  if (start === -1) return "";
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (/^## /.test(lines[i])) { end = i; break; }
  }
  return lines.slice(start, end).join("\n");
}

// Prose with fenced ``` blocks removed — for "must not appear outside a code fence" checks.
function stripFences(content) {
  return content.replace(/```[\s\S]*?```/g, "");
}

// Every SKILL.md and references/*.md under plugins/swarm/skills/.
function skillMarkdownFiles(dir) {
  const out = [];
  for (const name of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, name.name);
    if (name.isDirectory()) out.push(...skillMarkdownFiles(p));
    else if (name.name === "SKILL.md" || (name.name.endsWith(".md") && dirname(p).endsWith("references"))) out.push(p);
  }
  return out;
}

// Build a temp <projectsRoot>/<encoded-cwd>/ dir and drop `jsonl` in it as the
// session transcript. Returns { projectsRoot, cwd }.
function fixtureProject(cwd, jsonl) {
  const projectsRoot = mkdtempSync(join(tmpdir(), "swarm-onboard-"));
  const dir = join(projectsRoot, encodeProjectDir(cwd));
  mkdirSync(dir, { recursive: true });
  if (jsonl != null) writeFileSync(join(dir, "session.jsonl"), jsonl);
  return { projectsRoot, cwd };
}

// One assistant turn with a usage object, as Claude Code writes it.
function turn(model, usage) {
  return JSON.stringify({ type: "assistant", message: { role: "assistant", model, usage } });
}

// ---- T12 ----

test("T12a — reads first assistant turn's input_tokens + cache_creation", () => {
  const cwd = "C:\\code\\demo-project";
  // Head turn: 1200 + 38800 = 40000. A later turn with different numbers must be ignored.
  const jsonl = [
    JSON.stringify({ type: "user", message: { role: "user", content: "hi" } }),
    turn("claude-sonnet-4-5", { input_tokens: 1200, cache_creation_input_tokens: 38800, cache_read_input_tokens: 500000, output_tokens: 10 }),
    turn("claude-sonnet-4-5", { input_tokens: 999999, cache_creation_input_tokens: 999999 }),
  ].join("\n");
  const { projectsRoot } = fixtureProject(cwd, jsonl);

  const r = onboardingCost({ cwd, projectsRoot, now: new Date("2026-07-26T00:00:00Z") });
  equal(r.onboardingTokens, 40000, "sum of first turn's input + cache_creation, cache_read excluded");
  equal(r.source, "transcript");
  equal(r.model, "claude-sonnet-4-5");
  equal(r.contextWindow, 200000);
});

test("T12b — no transcript falls back to the dated ~40k constant", () => {
  const { projectsRoot, cwd } = fixtureProject("C:\\code\\empty-project", null);
  const r = onboardingCost({ cwd, projectsRoot, now: new Date("2026-07-26T00:00:00Z") });
  equal(r.source, "fallback");
  equal(r.onboardingTokens, 40000);
  equal(r.model, null);
  equal(r.contextWindow, 200000);
});

test("T12c — model to window map", () => {
  const cwd = "C:\\code\\opus-project";
  const jsonl = turn("claude-opus-4-8", { input_tokens: 1000, cache_creation_input_tokens: 60000 });
  const { projectsRoot } = fixtureProject(cwd, jsonl);
  const r = onboardingCost({ cwd, projectsRoot });
  equal(r.contextWindow, 1000000, "opus maps to 1M");

  equal(contextWindowFor("claude-opus-4-8"), 1000000);
  equal(contextWindowFor("claude-fable-5"), 1000000);
  equal(contextWindowFor("claude-sonnet-4-5"), 200000);
  equal(contextWindowFor("claude-haiku-4-5"), 200000);
  equal(contextWindowFor("glm-5.2:cloud"), 200000, "unknown model defaults to 200k");
  equal(contextWindowFor(null), 200000);
});

test("T12d — encodeProjectDir rewrites \\ / : to -", () => {
  equal(encodeProjectDir("C:\\code\\claude-plugin-marketplace"), "C--code-claude-plugin-marketplace");
  ok(!/[\\/:]/.test(encodeProjectDir("C:/a/b:c")));
});

// ---- T1: the skill exists and parses ----

test("T1 — orchestrating-agents/SKILL.md exists with valid name + description frontmatter", () => {
  const content = read(NEW_SKILL);
  const fm = content.match(/^---\n([\s\S]*?)\n---\n/);
  ok(fm, "frontmatter delimited by --- present");
  const nameLine = fm[1].match(/^name:\s*(.+)$/m);
  ok(nameLine, "name: key present");
  equal(nameLine[1].trim(), "orchestrating-agents");
  const desc = fm[1].match(/^description:\s*>-?\s*\n([\s\S]+)$/m) || fm[1].match(/^description:\s*(.+)$/m);
  ok(desc, "description: key present");
  ok(desc[1].trim().length > 0, "description non-empty");
});

// ---- T2: swarm gate references the skill, inside the gate section ----

test("T2 — swarm offer gate references orchestrating-agents within the gate section", () => {
  const gate = sectionSlice(read(SWARM_SKILL), "## MANDATORY first step — the offer gate");
  ok(gate.length > 0, "gate section found");
  ok(gate.includes("orchestrating-agents"), "gate section names the skill");
});

// ---- T3: three questions, no surviving TWO ----

test("T3 — gate carries THREE questions, no surviving TWO", () => {
  const gate = sectionSlice(read(SWARM_SKILL), "## MANDATORY first step — the offer gate");
  ok(!/two questions/i.test(gate), "no 'two questions' phrasing survives");
  ok(/THREE questions/.test(gate), "'THREE questions' present");
  const stanzas = gate.split("\n").filter((l) => /^\d+\.\s+>/.test(l));
  equal(stanzas.length, 3, "exactly three numbered question stanzas");
});

// ---- T4: arithmetic template complete ----

test("T4 — arithmetic template carries all six labels", () => {
  const content = read(NEW_SKILL);
  for (const label of ["fan-out:", "inline:", "batched:", "zero-leaf:", "axis:", "timeout:"]) {
    ok(content.includes(label), `arithmetic label ${label} present`);
  }
});

// ---- T5: gate question offers four named options ----

test("T5 — gate question table offers all four named options", () => {
  const content = read(NEW_SKILL);
  for (const opt of ["**Zero-leaf", "**Deep", "**Moderate", "**Per-item"]) {
    ok(content.includes(opt), `option ${opt} present`);
  }
});

// ---- T6: SSOT — the arithmetic label lives in exactly one file ----

test("T6 — zero-leaf: label appears in exactly one skill file, the new skill", () => {
  const files = skillMarkdownFiles(SKILLS_DIR);
  const hits = files.filter((p) => read(p).includes("zero-leaf:"));
  equal(hits.length, 1, `expected 1 file with 'zero-leaf:' label, got ${hits.length}: ${hits.join(", ")}`);
  ok(hits[0].replace(/\\/g, "/").endsWith("orchestrating-agents/SKILL.md"), "the one file is the new skill");
});

// ---- T8: jurisdiction — the shipped skill names no harness tool ----

test("T8 — new skill names no backticked harness tool", () => {
  const content = read(NEW_SKILL);
  for (const tok of ["`Workflow`", "`Agent`", "subagent_type", "PreToolUse", "parallel(", "pipeline("]) {
    ok(!content.includes(tok), `harness token ${tok} must be absent`);
  }
  // control: ordinary English must keep passing
  ok(content.includes("agents") && content.includes("parallel") && content.includes("fan-out"));
});

// ---- T9: timeout bound with sizing default and prompt line ----

test("T9 — timeout present with commit-as-you-go line, per-leaf sizing, and 45m default", () => {
  const content = read(NEW_SKILL);
  match(content, /commit\s+as\s+you\s+go/i); // verbatim prompt line (soft-wrap tolerant)
  match(content, /per[- ]leaf/i);
  const m45 = content.match(/45\s*m/gi) || [];
  ok(m45.length >= 2, `45m appears in both arithmetic and sizing (found ${m45.length})`);
});

// ---- T10: resume carve-out in swarm, keyed on failure kind, not in the new skill ----

test("T10 — resume carve-out is in swarm gate, three branches, and absent from new skill", () => {
  const gate = sectionSlice(read(SWARM_SKILL), "## MANDATORY first step — the offer gate");
  match(gate, /carve-out/i);                        // (a) present in gate section
  match(gate, /timed out|timeout/i);                // (b1) timeout branch
  match(gate, /retry|once/i);                       // (b2) error-retry branch
  match(gate, /committed nothing|second time|no progress/i); // (b3) no-progress branch
  ok(!/carve-out/i.test(read(NEW_SKILL)), "(c) carve-out absent from the new skill — gate rules live in one file");
});

// ---- T11: tier partition present, defers tier judgement, no model names in prose ----

test("T11 — tier partition names pipeline:model-selection with both asymmetry directions", () => {
  const content = read(NEW_SKILL);
  // arm (a)
  ok(content.includes("pipeline:model-selection"), "defers tier judgement to pipeline:model-selection");
  match(content, /one pin|single model|one model pin/i);
  match(content, /upward/i);
  match(content, /never the session's call|prohibition/i);
  // arm (b) — no model-name tokens in prose (outside fenced worked examples)
  const prose = stripFences(content);
  ok(!/\b(Haiku|Sonnet|Opus)\b/.test(prose), "no model-family name in prose");
  ok(!/:cloud/.test(prose), "no :cloud token in prose");
});

// ---- T13: Superpowers discipline-skill house style (Anthropic RED-GREEN template) ----

test("T13 — skill follows the Superpowers discipline-skill structure", () => {
  const content = read(NEW_SKILL);
  // Overview with a Core-principle line and the spirit-of-the-rule statement
  ok(/^## Overview$/m.test(content), "## Overview heading present");
  match(content, /\*\*Core principle:\*\*/);
  match(content, /Violating the letter of this rule is violating the spirit/i);
  // The Iron Law: its own heading, a fenced ALL-CAPS one-line law, and No exceptions
  const iron = sectionSlice(content, "## The Iron Law");
  ok(iron.length > 0, "## The Iron Law section present");
  const fence = iron.match(/```\n([^\n]+)\n```/);
  ok(fence, "Iron Law carries a fenced one-line law");
  const law = fence[1].trim();
  equal(law, law.toUpperCase(), `the law is ALL-CAPS (got: ${law})`);
  ok(/FAN-OUT/.test(law) && /FIRST/.test(law), "law states the fan-out precondition");
  match(iron, /\*\*No exceptions:\*\*/);
  // Bulletproofing sections named as the family names them
  ok(/^## Common Rationalizations$/m.test(content), "## Common Rationalizations heading present");
  ok(/^## Red Flags - STOP$/m.test(content), "## Red Flags - STOP heading present");
});

// ---- T14: the resume carve-out spells out the mechanics agents spin on ----

test("T14 — resume carve-out states --resume, no re-onboard, and ok-leaves-skipped", () => {
  const gate = sectionSlice(read(SWARM_SKILL), "## MANDATORY first step — the offer gate");
  match(gate, /--resume/, "names the underlying `claude --resume <sessionId>` mechanism");
  match(gate, /re-?onboard/i, "states the no-re-onboarding invariant");
  match(gate, /never re-run|skipped, never|already-?`?ok`?[^\n]*skipped/i, "states already-ok leaves are not re-run");
});
