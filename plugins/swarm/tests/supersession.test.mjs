import { test } from "node:test";
import { equal, deepEqual } from "node:assert/strict";
import { collapseFamilies, visibleModels } from "../src/discovery.mjs";

test("Kimi code alias supersedes the preceding Kimi generation", () => {
  const models = collapseFamilies([
    { model: "kimi-k2.6:cloud" },
    { model: "kimi-k2.7-code:cloud" },
  ]);
  const elder = models.find((model) => model.model === "kimi-k2.6:cloud");
  equal(elder.supersededBy, "kimi-k2.7-code:cloud");
  deepEqual(visibleModels(models).map((model) => model.model), ["kimi-k2.7-code:cloud"]);
});

test("distinct GLM flash and base models both remain visible", () => {
  const models = collapseFamilies([
    { model: "glm-5.3-flash:cloud" },
    { model: "glm-5.3:cloud" },
  ]);
  deepEqual(visibleModels(models).map((model) => model.model), ["glm-5.3-flash:cloud", "glm-5.3:cloud"]);
});

test("version comparison pads numeric prefixes but preserves tag forks", () => {
  const models = collapseFamilies([
    { model: "glm-5:cloud" },
    { model: "glm-5.1:cloud" },
    { model: "kimi-k3:cloud" },
    { model: "kimi-k3:0901-cloud" },
    { model: "deepseek-v4-flash:0830-cloud" },
    { model: "deepseek-v4.1-flash:cloud" },
  ]);
  const byName = Object.fromEntries(models.map((model) => [model.model, model]));
  equal(byName["glm-5:cloud"].supersededBy, "glm-5.1:cloud");
  equal(byName["kimi-k3:cloud"].supersededBy, undefined);
  equal(byName["kimi-k3:0901-cloud"].supersededBy, undefined);
  equal(byName["deepseek-v4-flash:0830-cloud"].supersededBy, "deepseek-v4.1-flash:cloud");
});

test("zero-padded date stamps do not supersede real OpenAI generations", () => {
  const models = collapseFamilies([
    { model: "gpt-4.1" },
    { model: "gpt-4-0613" },
    { model: "gpt-5" },
  ], "");
  const byName = Object.fromEntries(models.map((model) => [model.model, model]));
  equal(byName["gpt-4.1"].supersededBy, "gpt-5");
  equal(byName["gpt-4-0613"].supersededBy, "gpt-4.1");
});

test("Claude dash-separated versions compare as major and minor numbers", () => {
  const models = collapseFamilies([
    { model: "claude-opus-4-5" },
    { model: "claude-opus-5" },
    { model: "claude-opus-5-5" },
    { model: "claude-sonnet-4-6" },
    { model: "claude-sonnet-5" },
  ], "");
  const byName = Object.fromEntries(models.map((model) => [model.model, model]));
  equal(byName["claude-opus-4-5"].supersededBy, "claude-opus-5");
  equal(byName["claude-opus-5"].supersededBy, "claude-opus-5-5");
  equal(byName["claude-sonnet-4-6"].supersededBy, "claude-sonnet-5");
});

test("date-stamp segments stay separate from dash-separated versions", () => {
  const models = collapseFamilies([
    { model: "claude-x-4-5" },
    { model: "claude-x-4-5-20250929" },
  ], "");
  deepEqual(models.map((model) => model.supersededBy), [undefined, undefined]);
});

test("empty suffix preserves rate-card model names for family comparison", () => {
  const models = collapseFamilies([
    { model: "glm-5" },
    { model: "glm-5.1" },
  ], "");
  equal(models.find((model) => model.model === "glm-5").supersededBy, "glm-5.1");
});
