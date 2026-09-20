import { test } from "node:test";
import { equal, ok } from "node:assert/strict";
import { declaredEfforts, effortFor, isClaudeModel, tierFromModel, isValidEffort } from "../src/models.mjs";

test("isClaudeModel matrix", () => {
  for (const m of ["haiku", "sonnet", "opus", "fable", "Sonnet", "claude-haiku-4-5", "claude-opus-4-8-20260101"]) {
    equal(isClaudeModel(m), true, `${m} should be Claude`);
  }
  for (const m of ["glm-4.6:cloud", "minimax-m3:cloud", "qwen3-coder:cloud", "gpt-oss:cloud", "", null, undefined, "sonnetish-model"]) {
    equal(isClaudeModel(m), false, `${m} should NOT be Claude`);
  }
});

test("tierFromModel tolerates dated ids and aliases", () => {
  equal(tierFromModel("claude-haiku-4-5-20251001"), "haiku");
  equal(tierFromModel("sonnet"), "sonnet");
  equal(tierFromModel("claude-opus-4-8"), "opus");
  equal(tierFromModel("fable"), "fable");
  equal(tierFromModel("glm-4.6:cloud"), null);
});

test("isValidEffort: only a declared list can reject a value", () => {
  const declared = ["low", "medium", "high", "xhigh"];
  equal(isValidEffort("gpt-5.5", "max", declared), false);
  equal(isValidEffort("gpt-5.5", "xhigh", declared), true);
  equal(isValidEffort("claude-haiku-4-5-20251001", "max"), true);
  equal(isValidEffort("claude-sonnet-5", "xhigh"), true);
});

test("isValidEffort: open models accept any effort (pass-through)", () => {
  for (const e of ["low", "medium", "high", "xhigh", "max", "weird-custom"]) {
    ok(isValidEffort("minimax-m3:cloud", e, undefined));
  }
});

test("isValidEffort: absent effort always valid; unclassifiable claude-* accepts any", () => {
  equal(isValidEffort("haiku", undefined), true);
  equal(isValidEffort("claude-newtier-9", "max"), true);
});

test("effortFor and declaredEfforts use the provider-qualified cache row", () => {
  const cache = [
    { provider: "ollama", model: "same", efforts: ["max"] },
    { provider: "codex", model: "same", efforts: ["low", "medium"], defaultEffort: "low" },
  ];
  const declared = declaredEfforts("same", "codex", cache);
  equal(declared.defaultEffort, "low");
  equal(effortFor({}, declared), "low");
  equal(effortFor({ effort: "high" }, declared), "high");
  equal(effortFor({}, undefined), "medium");
});

