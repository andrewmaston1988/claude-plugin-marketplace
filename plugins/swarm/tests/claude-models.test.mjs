import { test } from "node:test";
import { deepEqual, equal } from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { readClaudeCatalog } from "../src/claude-models.mjs";

function fixture(home, name, models, fetchedAt = 1) {
  const directory = join(home, ".claude", "cache", "model-catalog");
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, name), JSON.stringify({ fetchedAt, catalog: { config: { models } } }));
}

function model(id, thinking) {
  return { id, name: id, thinking };
}

test("Claude catalog maps effort options and the Default badge", () => {
  const home = mkdtempSync(join(tmpdir(), "swarm-claude-catalog-"));
  try {
    fixture(home, "catalog-with-a-different-name-cc.json", [model("claude-sonnet-5", {
      type: "effort",
      effort_options: [
        { id: "low" },
        { id: "medium", badge: { message: "Default" } },
        { id: "high" },
      ],
    })]);
    deepEqual(readClaudeCatalog({ HOME: home }), [{
      provider: "claude",
      runner: "claude",
      model: "claude-sonnet-5",
      displayName: "claude-sonnet-5",
      efforts: ["low", "medium", "high"],
      defaultEffort: "medium",
    }]);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("Claude catalog omits efforts for thinking.type none and a missing badge", () => {
  const home = mkdtempSync(join(tmpdir(), "swarm-claude-catalog-"));
  try {
    fixture(home, "catalog-rows-cc.json", [
      model("claude-haiku-4-5-20251001", { type: "none" }),
      model("claude-opus-5", { type: "effort", effort_options: [{ id: "low" }, { id: "high" }] }),
    ]);
    deepEqual(readClaudeCatalog({ HOME: home }), [
      { provider: "claude", runner: "claude", model: "claude-haiku-4-5-20251001", displayName: "claude-haiku-4-5-20251001" },
      { provider: "claude", runner: "claude", model: "claude-opus-5", displayName: "claude-opus-5", efforts: ["low", "high"] },
    ]);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("Claude catalog failures return an empty list", () => {
  const missing = mkdtempSync(join(tmpdir(), "swarm-claude-catalog-"));
  try {
    deepEqual(readClaudeCatalog({ HOME: missing }), []);
    fixture(missing, "malformed-name-cc.json", []);
    writeFileSync(join(missing, ".claude", "cache", "model-catalog", "malformed-name-cc.json"), "{");
    deepEqual(readClaudeCatalog({ HOME: missing }), []);
    fixture(missing, "unexpected-shape-cc.json", []);
    writeFileSync(join(missing, ".claude", "cache", "model-catalog", "unexpected-shape-cc.json"), JSON.stringify({ fetchedAt: 2, catalog: {} }));
    deepEqual(readClaudeCatalog({ HOME: missing }), []);
  } finally {
    rmSync(missing, { recursive: true, force: true });
  }
});

test("Claude catalog chooses the newest fetchedAt among globbed files", () => {
  const home = mkdtempSync(join(tmpdir(), "swarm-claude-catalog-"));
  try {
    fixture(home, "older-uuidish-cc.json", [model("old", { type: "effort", effort_options: [{ id: "low" }] })], 1);
    fixture(home, "newer-hashish-cc.json", [model("new", { type: "effort", effort_options: [{ id: "high", badge: { message: "Default" } }] })], 2);
    equal(readClaudeCatalog({ HOME: home })[0].model, "new");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
