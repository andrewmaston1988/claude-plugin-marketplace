import { test } from "node:test";
import assert from "node:assert/strict";
import { projectGrouping } from "../src/serve/grouping.mjs";

// The rule moved byte-identically out of page.html. These pin the real key shapes
// taken from ~/.swarm/runs — with the plain repo keys present, as they are on disk —
// so the move cannot quietly mislabel somebody's estate.
test("real estate shapes: a worktree key groups into its repo and labels as the repo", () => {
  const keys = [
    "C--code-primordial",
    "C--code-long-night",
    "C--code-gene-pool",
    "C--code-claude-plugin-marketplace",
    "C--code-.worktrees-primordial-carrion",
    "C--code-long-night-.claude-worktrees-loadout-and-bags",
    "C--code-gene-pool-.swarm_species_shots",
  ];
  const { groupOf, labelOf } = projectGrouping(keys);
  assert.equal(groupOf("C--code-.worktrees-primordial-carrion"), "C--code-primordial");
  assert.equal(labelOf("C--code-primordial"), "primordial");
  assert.equal(groupOf("C--code-long-night-.claude-worktrees-loadout-and-bags"), "C--code-long-night");
  assert.equal(labelOf("C--code-long-night"), "long-night");
  assert.equal(groupOf("C--code-gene-pool-.swarm_species_shots"), "C--code-gene-pool");
  assert.equal(labelOf("C--code-gene-pool"), "gene-pool");
});

test("longest prefix wins: the marketplace is its own group, never folded into a shorter plain key", () => {
  const { groupOf } = projectGrouping(["C--code-claude", "C--code-claude-plugin-marketplace"]);
  assert.equal(groupOf("C--code-claude-plugin-marketplace"), "C--code-claude-plugin-marketplace");
  assert.equal(groupOf("C--code-claude"), "C--code-claude");
});

test("a lone key groups as itself and labels as the key, never the empty string", () => {
  // Nothing shares its prefix, so there is nothing to strip — the label is the key.
  const { groupOf, labelOf } = projectGrouping(["C--code-solo"]);
  assert.equal(groupOf("C--code-solo"), "C--code-solo");
  assert.equal(labelOf("C--code-solo"), "C--code-solo");
  assert.notEqual(labelOf("C--code-solo"), "");
});
