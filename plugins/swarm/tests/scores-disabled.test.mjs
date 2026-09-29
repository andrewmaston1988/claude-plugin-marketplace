import { test } from "node:test";
import { deepEqual } from "node:assert/strict";
import { hideDisabledRows } from "../src/scores.mjs";
import { defaultProviderRegistry } from "../src/default-providers.mjs";

test("hideDisabledRows: a provider-less row is attributed through the roster; unattributable rows stay", () => {
  const registry = defaultProviderRegistry();
  const cfgWith = (on) => ({ providers: Object.fromEntries(["claude", "ollama", "codex"].map((id) => [id, { enabled: on.includes(id) }])) });
  const roster = [{ provider: "codex", model: "gpt-6-luna" }];
  const legacy = { model: "gpt-6-luna" };
  const unknown = { model: "mystery-model" };
  const models = (rows) => rows.map((r) => r.model);

  deepEqual(models(hideDisabledRows([legacy, unknown], cfgWith(["claude", "ollama"]), registry, roster)), ["mystery-model"],
    "codex off: the roster attributes the legacy gpt row to it, so it is hidden");
  deepEqual(models(hideDisabledRows([legacy, unknown], cfgWith(["codex"]), registry, roster)), ["gpt-6-luna", "mystery-model"],
    "codex on: the row shows");
  deepEqual(models(hideDisabledRows([legacy], cfgWith(["claude", "ollama"]), registry, [])), ["gpt-6-luna"],
    "no source attributes the row: kept");
  deepEqual(models(hideDisabledRows([legacy], cfgWith(["ollama"]), registry, [{ provider: "codex", model: "gpt-6-luna" }, { provider: "ollama", model: "gpt-6-luna" }])), ["gpt-6-luna"],
    "a model an enabled provider also lists is ambiguous: kept");
});
