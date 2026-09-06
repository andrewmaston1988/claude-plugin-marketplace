import { test } from "node:test";
import { equal, ok, match } from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

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

// Every file under plugins/swarm/skills/, any extension — T16 needs to catch a
// deleted script's filename, not just markdown prose.
function allSkillFiles(dir) {
  const out = [];
  for (const name of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, name.name);
    if (name.isDirectory()) out.push(...allSkillFiles(p));
    else out.push(p);
  }
  return out;
}

// Slice a `## <prefix>`-level section (heading line through the line before the
// next `## ` heading) by prefix match, for numbered sub-sections like "## 3a".
function sectionByPrefix(content, prefix) {
  const lines = content.split("\n");
  const start = lines.findIndex((l) => l.trim().startsWith(prefix));
  if (start === -1) return "";
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (/^## /.test(lines[i])) { end = i; break; }
  }
  return lines.slice(start, end).join("\n");
}

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

// ---- T4: §2 block carries the three-legged labels, not the onboarding ones ----

test("T4 — §2 block carries wall-clock/blast/axis/timeout", () => {
  const content = read(NEW_SKILL);
  for (const label of ["wall-clock:", "blast:", "axis:", "timeout:"]) {
    ok(content.includes(label), `arithmetic label ${label} present`);
  }
});

test("T4 — §2 block drops the old onboarding-arithmetic labels", () => {
  const content = read(NEW_SKILL);
  for (const label of ["fan-out:", "batched:", "zero-leaf:", "inline:"]) {
    ok(!content.includes(label), `old label ${label} must be gone`);
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

test("T6 — wall-clock: label appears in exactly one skill file, the new skill", () => {
  const files = skillMarkdownFiles(SKILLS_DIR);
  const hits = files.filter((p) => read(p).includes("wall-clock:"));
  equal(hits.length, 1, `expected 1 file with 'wall-clock:' label, got ${hits.length}: ${hits.join(", ")}`);
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

test("T11 — tier partition defers to swarm's own tier guide with both asymmetry directions", () => {
  const content = read(NEW_SKILL);
  // arm (a) — the guide lives in this plugin; a cross-plugin pointer breaks standalone installs
  ok(content.includes("../swarm/references/model-selection.md"), "defers tier judgement to swarm's references/model-selection.md");
  ok(!content.includes("pipeline:model-selection"), "no pointer into the pipeline plugin");
  match(content, /one pin|single model|one model pin/i);
  match(content, /upward/i);
  match(content, /never the session's call|prohibition/i);
  // arm (b) — no model-name tokens in prose (outside fenced worked examples)
  const prose = stripFences(content);
  ok(!/\b(Haiku|Sonnet|Opus)\b/.test(prose), "no model-family name in prose");
  ok(!/:cloud/.test(prose), "no :cloud token in prose");
});

// ---- T15: under swarm.always the gate is GONE, not restated more quietly ----

test("T15 — the gate section branches to dispatch under swarm.always, emitting and asking nothing", () => {
  const gate = sectionSlice(read(SWARM_SKILL), "## MANDATORY first step — the offer gate");
  ok(/^### Standing consent/m.test(gate), "'### Standing consent' subsection present in the gate");
  ok(gate.includes("swarm.always"), "names the config key");
  // The branch must come BEFORE the gate's own text, or a reader meets the gate first.
  ok(gate.indexOf("`swarm.always` is set") < gate.indexOf("THE GATE'S ANSWER"), "branch precedes the gate");
  match(gate, /Emit nothing/);
  match(gate, /Ask nothing/);
  // The recital this replaced. Its return is the regression T15 exists to catch:
  // a "statement in place of the question" is still a wall of text before every run.
  ok(!/printed statement/i.test(gate), "no printed-statement recital");
  ok(!/waives the question, never the ceremony/i.test(gate), "no ceremony-recital wording");
  // Reading the two skills stays mandatory — dropping them is the opposite failure.
  match(gate, /READ them/);
  // the skip is stated in the mix stanza itself, for the non-standing path
  match(gate, /Anthropic-only by construction/);
  // orchestrating-agents and executing-swarms echo the same mode
  ok(read(NEW_SKILL).includes("swarm.always"), "orchestrating-agents knows the mode");
  ok(read(join(SKILLS_DIR, "executing-swarms", "SKILL.md")).includes("swarm.always"), "executing-swarms knows the mode");
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

// ---- T16: the deleted onboarding-cost script leaves no trace under skills/ ----

test("T16 — nothing under skills/ names onboarding-cost", () => {
  const files = allSkillFiles(SKILLS_DIR);
  for (const p of files) {
    const norm = p.replace(/\\/g, "/");
    ok(!norm.includes("onboarding-cost"), `path ${norm} must not name onboarding-cost`);
    if (/\.(md|mjs)$/.test(norm)) {
      ok(!read(p).includes("onboarding-cost"), `${norm} must not reference onboarding-cost`);
    }
  }
});

// ---- T17: no surviving "a merge saves an onboarding" reasoning ----

const SAVES_ONBOARDING_RE = /sav(e|es|ed|ing)\s+(an|one)\s+(entire\s+|whole\s+|exactly\s+one\s+)?onboarding/i;
const ONBOARDING_ARITHMETIC_RE = /onboarding\s+arithmetic/i;

test("T17 — the two grouping skills carry no onboarding-saving phrasing or 'onboarding arithmetic'", () => {
  const files = [NEW_SKILL, join(SKILLS_DIR, "executing-swarms", "SKILL.md")];
  for (const p of files) {
    const content = read(p);
    const norm = p.replace(/\\/g, "/");
    ok(!SAVES_ONBOARDING_RE.test(content), `${norm} must not say a merge saves an onboarding`);
    ok(!ONBOARDING_ARITHMETIC_RE.test(content), `${norm} must not name "onboarding arithmetic"`);
  }
});

// ---- T18: §3a decompose-by-files step is on the page ----

test("T18 — §3a exists and states partition / disjoint files / step number", () => {
  const content = read(NEW_SKILL);
  const section = sectionByPrefix(content, "## 3a");
  ok(section.length > 0, "§3a section present");
  ok(section.includes("partition"), "mentions partition");
  ok(section.includes("disjoint files"), "mentions disjoint files");
  ok(section.includes("step number"), "mentions step number");
});
