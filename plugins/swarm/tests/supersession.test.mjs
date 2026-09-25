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
