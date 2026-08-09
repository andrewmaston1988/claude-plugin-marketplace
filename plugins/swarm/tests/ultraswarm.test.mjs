import { test } from "node:test";
import { equal, ok } from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { formatModelList } from "../hooks/ultraswarm.mjs";

test("formatModelList hides superseded entries and skips denylisted ones", async () => {
  const cache = { models: [
    { model: "glm-5.2:cloud", description: "Frontier" },
    { model: "glm-5.1:cloud", description: "Prior", supersededBy: "glm-5.2:cloud" },
    { model: "nemotron-3-super:cloud", description: "Banned" },
  ] };
  equal(await formatModelList(cache, { modelDenylist: ["nemotron"] }), "- glm-5.2:cloud — Frontier");
});

test("formatModelList: removed superseder -> elder resurfaces; denylisted superseder -> elder shown", async () => {
  // superseder absent from the cache (402 removal) — the elder is usable again
  equal(
    await formatModelList({ models: [{ model: "glm-5.1:cloud", description: "Prior", supersededBy: "glm-5.2:cloud" }] }),
    "- glm-5.1:cloud — Prior",
  );
  // superseder present but denylisted — it disappears AND stops hiding the elder
  equal(
    await formatModelList({ models: [
      { model: "glm-5.2:cloud", description: "Frontier" },
      { model: "glm-5.1:cloud", description: "Prior", supersededBy: "glm-5.2:cloud" },
    ] }, { modelDenylist: ["glm-5.2"] }),
    "- glm-5.1:cloud — Prior",
  );
});

test("formatModelList renders legacy cache shapes unchanged", async () => {
  equal(await formatModelList({ models: [{ model: "a", description: "d" }, { model: "b" }] }), "- a — d\n- b");
  equal(await formatModelList({ recommendations: [{ model: "a", description: "d" }] }), "- a — d");
  equal(await formatModelList(["a", "b"]), "- a\n- b");
  equal(await formatModelList(null), "");
  equal(await formatModelList({}), "");
});

test("the hook never probes — display-only cache reads stay network-free", () => {
  const src = readFileSync(fileURLToPath(new URL("../hooks/ultraswarm.mjs", import.meta.url)), "utf8");
  ok(!src.includes("probeTopModels") && !src.includes("/api/generate"));
});
