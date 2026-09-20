import { test } from "node:test";
import { equal, deepEqual, ok } from "node:assert/strict";
import { isClaudeModel, tierFromModel, isValidEffort, TIER_EFFORTS } from "../src/models.mjs";

test("isClaudeModel matrix", () => {
  for (const m of ["haiku", "sonnet", "opus", "fable", "Sonnet", "claude-haiku-4-5", "claude-opus-4-8-20260101"]) {
    equal(isClaudeModel(m), true, `${m} should be Claude`);
  }
  for (const m of ["glm-4.6:cloud", "minimax-m3:cloud", "qwen3-coder:cloud", "gpt-oss:cloud", "", null, undefined, "sonnetish-model"]) {
    equal(isClaudeModel(m), false, `${m} should NOT be Claude`);
  }
});

test("TIER_EFFORTS shape per the locked matrix", () => {
  deepEqual(TIER_EFFORTS.haiku,  ["low", "medium", "high"]);
  deepEqual(TIER_EFFORTS.sonnet, ["low", "medium", "high", "max"]);
  deepEqual(TIER_EFFORTS.opus,   ["low", "medium", "high", "xhigh", "max"]);
  deepEqual(TIER_EFFORTS.fable,  ["low", "medium", "high", "xhigh", "max"]);
});

test("tierFromModel tolerates dated ids and aliases", () => {
  equal(tierFromModel("claude-haiku-4-5-20251001"), "haiku");
  equal(tierFromModel("sonnet"), "sonnet");
  equal(tierFromModel("claude-opus-4-8"), "opus");
  equal(tierFromModel("fable"), "fable");
  equal(tierFromModel("glm-4.6:cloud"), null);
});

test("isValidEffort: Claude tiers validate against the matrix", () => {
  equal(isValidEffort("haiku", "high"), true);
  equal(isValidEffort("haiku", "max"), false);
  equal(isValidEffort("haiku", "xhigh"), false);
  equal(isValidEffort("sonnet", "max"), true);
  equal(isValidEffort("sonnet", "xhigh"), false);
  equal(isValidEffort("opus", "xhigh"), true);
  equal(isValidEffort("claude-fable-5", "max"), true);
});

test("isValidEffort: open models accept any effort (pass-through)", () => {
  for (const e of ["low", "medium", "high", "xhigh", "max", "weird-custom"]) {
    ok(isValidEffort("minimax-m3:cloud", e));
  }
});

test("isValidEffort: absent effort always valid; unclassifiable claude-* accepts any", () => {
  equal(isValidEffort("haiku", undefined), true);
  equal(isValidEffort("claude-newtier-9", "max"), true);
});
