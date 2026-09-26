import { test } from "node:test";
import { equal, deepEqual } from "node:assert/strict";
import { collapseFamilies, collapseRoster, visibleModels } from "../src/discovery.mjs";

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

test("collapseFamilies: segment split marks elders superseded within a lineage", () => {
  const out = collapseFamilies([
    { model: "glm-5.2:cloud" }, { model: "glm-5.1:cloud" },
    { model: "kimi-k3:cloud" }, { model: "kimi-k2.6:cloud" },
    { model: "qwen3.6:cloud" }, { model: "qwen3.5:cloud" },
    { model: "gemma5:31b-cloud" }, { model: "gemma4:31b-cloud" },
  ]);
  const byName = Object.fromEntries(out.map((m) => [m.model, m]));
  equal(byName["glm-5.1:cloud"].supersededBy, "glm-5.2:cloud");
  equal(byName["glm-5.2:cloud"].supersededBy, undefined);
  equal(byName["kimi-k2.6:cloud"].supersededBy, "kimi-k3:cloud"); // lineage kimi-k
  equal(byName["qwen3.5:cloud"].supersededBy, "qwen3.6:cloud"); // multi-letter stem splits
  equal(byName["gemma4:31b-cloud"].supersededBy, "gemma5:31b-cloud"); // size tag joins the lineage
});

test("collapseFamilies: variant tags and size tags are lineage, not versions", () => {
  const out = collapseFamilies([
    { model: "kimi-k3:cloud" }, { model: "kimi-k2.7-code:cloud" },
    { model: "gpt-oss:20b-cloud" }, { model: "gpt-oss:120b-cloud" },
    { model: "deepseek-v4-flash:0830-cloud" }, { model: "deepseek-v4-flash:0731-cloud" },
    { model: "deepseek-v4-flash:preview-cloud" },
  ]);
  const byName = Object.fromEntries(out.map((m) => [m.model, m]));
  equal(byName["kimi-k2.7-code:cloud"].supersededBy, "kimi-k3:cloud");
  equal(byName["gpt-oss:20b-cloud"].supersededBy, undefined);
  equal(byName["gpt-oss:120b-cloud"].supersededBy, undefined);
  equal(byName["deepseek-v4-flash:0731-cloud"].supersededBy, "deepseek-v4-flash:0830-cloud");
  equal(byName["deepseek-v4-flash:preview-cloud"].supersededBy, undefined); // :preview is its own lineage
});

test("collapseFamilies: prefix-extension versions are incomparable — both kept", () => {
  const out = collapseFamilies([{ model: "kimi-k3:cloud" }, { model: "kimi-k3:0901-cloud" }]);
  deepEqual(out.map((m) => m.supersededBy), [undefined, undefined]);
});

test("visibleModels: elder hidden only while its superseder is usable", () => {
  const roster = [
    { model: "glm-5.2:cloud" },
    { model: "glm-5.1:cloud", supersededBy: "glm-5.2:cloud" },
  ];
  deepEqual(visibleModels(roster).map((m) => m.model), ["glm-5.2:cloud"]);
  // superseder removed from the cache (402 entitlement) → elder resurfaces
  deepEqual(visibleModels(roster.slice(1)).map((m) => m.model), ["glm-5.1:cloud"]);
  // superseder denylisted → elder resurfaces; the denylist itself filters at print, not here
  deepEqual(
    visibleModels(roster, { isDenylisted: (name) => name === "glm-5.2:cloud" }).map((m) => m.model),
    ["glm-5.2:cloud", "glm-5.1:cloud"],
  );
});

test("visibleModels: supersededBy chains walk to any usable newer entry", () => {
  const roster = [
    { model: "glm-5.2:cloud" },
    { model: "glm-5.1:cloud", supersededBy: "glm-5.2:cloud" },
    { model: "glm-5.0:cloud", supersededBy: "glm-5.1:cloud" },
  ];
  // 5.2 denylisted: 5.1 resurfaces and still hides 5.0
  deepEqual(
    visibleModels(roster, { isDenylisted: (n) => n === "glm-5.2:cloud" }).map((m) => m.model),
    ["glm-5.2:cloud", "glm-5.1:cloud"],
  );
});

// Only the Ollama roster was ever collapsed, so `swarm models` printed
// gpt-5.6-luna beside gpt-6-luna and claude-opus-4-8 beside claude-opus-5. One
// collapse site for every provider — the cloud suffix belongs to Ollama's naming,
// every other provider compares bare.
test("collapseRoster: every provider's roster collapses, bare outside Ollama", () => {
  const roster = collapseRoster([
    { provider: "codex", model: "gpt-5.6-luna" },
    { provider: "codex", model: "gpt-6-luna" },
    { provider: "codex", model: "gpt-5.6-sol" },
    { provider: "codex", model: "gpt-6-sol" },
    { provider: "codex", model: "gpt-5.6-terra" },
    { provider: "codex", model: "gpt-5.5" },
    { provider: "claude", model: "claude-opus-4-8" },
    { provider: "claude", model: "claude-opus-5" },
    { provider: "ollama", model: "glm-5:cloud" },
    { provider: "ollama", model: "glm-5.1:cloud" },
  ]);
  const by = Object.fromEntries(roster.map((m) => [`${m.provider}/${m.model}`, m]));
  equal(by["codex/gpt-5.6-luna"].supersededBy, "gpt-6-luna", roster.map((m) => m.model).join(","));
  equal(by["codex/gpt-5.6-sol"].supersededBy, "gpt-6-sol");
  equal(by["codex/gpt-5.6-terra"].supersededBy, undefined, "no newer sibling — terra stays");
  equal(by["codex/gpt-5.5"].supersededBy, undefined, "a bare gpt-5.5 family has no newer member");
  equal(by["claude/claude-opus-4-8"].supersededBy, "claude-opus-5");
  equal(by["ollama/glm-5:cloud"].supersededBy, "glm-5.1:cloud", "Ollama keeps its cloud suffix");
  deepEqual(visibleModels(roster.filter((m) => m.provider === "codex")).map((m) => m.model),
    ["gpt-6-luna", "gpt-6-sol", "gpt-5.6-terra", "gpt-5.5"]);
});
