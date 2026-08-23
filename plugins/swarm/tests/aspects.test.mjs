import { test } from "node:test";
import { deepEqual, ok, equal } from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { UNIVERSAL, CAPABILITY, ASPECTS, OUTCOMES, GRADED_OUTCOMES } from "../src/aspects.mjs";

const SRC = fileURLToPath(new URL("../src/", import.meta.url));

// The exact names, asserted literally: the skill doc, the README and the row
// schema all key off these strings, so a rename must break a test rather than
// silently split the store into two vocabularies.
test("aspects: the four universal and six capability names, exactly", () => {
  deepEqual(UNIVERSAL, ["adherence", "handoff", "truthfulness", "depth"]);
  deepEqual(CAPABILITY, ["discrimination", "code", "search", "web", "vision", "geometry"]);
});

test("aspects: UNIVERSAL and CAPABILITY are disjoint, and ASPECTS is their concatenation", () => {
  for (const a of UNIVERSAL) ok(!CAPABILITY.includes(a), `${a} is in both sets`);
  deepEqual(ASPECTS, [...UNIVERSAL, ...CAPABILITY]);
  equal(new Set(ASPECTS).size, 10);
});

test("aspects: the six outcomes, not-capable among them", () => {
  deepEqual(OUTCOMES, ["completed", "wrong", "failed", "timeout", "session-died", "not-capable"]);
  ok(OUTCOMES.includes("not-capable"));
  deepEqual(GRADED_OUTCOMES, ["completed", "wrong"]);
  for (const o of GRADED_OUTCOMES) ok(OUTCOMES.includes(o));
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
