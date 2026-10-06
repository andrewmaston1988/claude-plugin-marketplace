import { test } from "node:test";
import { deepEqual, ok, equal } from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { UNIVERSAL, CAPABILITY, ASPECTS, OUTCOMES, INFRA_OUTCOMES, GRADED_OUTCOMES } from "../src/aspects.mjs";

const SRC = fileURLToPath(new URL("../src/", import.meta.url));

// The exact names, asserted literally: the skill doc, the README and the row
// schema all key off these strings, so a rename must break a test rather than
// silently split the store into two vocabularies.
test("aspects: the four universal and seven capability names, exactly", () => {
  deepEqual(UNIVERSAL, ["adherence", "handoff", "truthfulness", "depth"]);
  deepEqual(CAPABILITY, ["discrimination", "code", "impl", "search", "web", "vision", "geometry"]);
});

test("aspects: UNIVERSAL and CAPABILITY are disjoint, and ASPECTS is their concatenation", () => {
  for (const a of UNIVERSAL) ok(!CAPABILITY.includes(a), `${a} is in both sets`);
  deepEqual(ASPECTS, [...UNIVERSAL, ...CAPABILITY]);
  equal(new Set(ASPECTS).size, 11);
});

test("aspects: the nine outcomes, not-capable and the three infra ones among them", () => {
  deepEqual(OUTCOMES, ["completed", "wrong", "failed", "timeout", "session-died", "not-capable", "quota", "rate-limited", "harness"]);
  ok(OUTCOMES.includes("not-capable"));
  deepEqual(INFRA_OUTCOMES, ["quota", "rate-limited", "harness"]);
  for (const o of INFRA_OUTCOMES) ok(OUTCOMES.includes(o), `${o} must be a stored outcome, not a display-only label`);
  deepEqual(GRADED_OUTCOMES, ["completed", "wrong"]);
});

// Infra outcomes are about the machinery, never the model: they forbid grades
// exactly as `failed` does, and they must not overlap the graded pair.
test("aspects: an infra outcome is never a graded outcome", () => {
  for (const o of INFRA_OUTCOMES) ok(!GRADED_OUTCOMES.includes(o), `${o} forbids grades`);
});

// Aspect inference was cut for cause and looks like an obviously helpful
// addition, so a future session will be tempted to re-add it. Stem mining found
// ZERO of the corpus's ~784 visual leaves — swarm ids are subject nouns
// (`icons`, `attachments`), not kind labels — which makes the inference worst
// exactly where the work is heaviest.
test("aspects: nothing in src/ infers an aspect from a leaf id", () => {
  const banned = ["suggestAspect", "inferAspect", "aspectFor", "STEM_", "stemToAspect"];
  const hits = [];
  for (const f of readdirSync(SRC).filter((f) => f.endsWith(".mjs"))) {
    const text = readFileSync(join(SRC, f), "utf8");
    for (const name of banned) if (text.includes(name)) hits.push(`${f}: ${name}`);
  }
  deepEqual(hits, [], "aspect inference from leaf ids was cut for cause — the grading agent declares the aspects");
});
