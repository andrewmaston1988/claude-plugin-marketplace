import { test } from "node:test";
import { equal } from "node:assert/strict";
import { aggregate, overall } from "../src/scores.mjs";

test("a model drill-in shows the same shrunk score the full table ranks on", () => {
  const leaf = (model, score, i) => ({
    resultsDir: `C:/runs/drill-${i}`, leaf: `${model}-${i}`, provider: "ollama", model, domain: "godot",
    grades: { adherence: score, handoff: score, truthfulness: score, depth: score },
    outcome: "completed", note: "x", assessedBy: { session: "s" },
  });
  const rows = [
    ...Array.from({ length: 8 }, (_, i) => leaf("strong", 9, i)),
    ...Array.from({ length: 2 }, (_, i) => leaf("thin", 5, i)),
  ];
  const field = overall(rows, { combineProviders: true }).cells.find((c) => c.model === "thin");
  const drill = overall(rows, { model: "thin", combineProviders: true }).cells[0];
  equal(drill.combined, field.combined, "the drill-in shrank toward its own mean instead of the field's");
  equal(aggregate(rows, { model: "thin", aspect: "depth" }).aspects[0].cells[0].weighted,
    aggregate(rows, { aspect: "depth" }).aspects[0].cells.find((c) => c.model === "thin").weighted);
});
