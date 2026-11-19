// Shared registration for the four lifecycle shard files: each shard runs the cells
// whose index falls to it (`i % SHARD_COUNT`), so `node --test` gives every shard its
// own process. The name has no .test suffix on purpose — the suite globs must not run
// this file as a fifth test file.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { startSession } from "./session-sim.mjs";
import { CELLS, CUT_WAIT_CELLS, cellName, runCell } from "./scenarios.mjs";
import { regressions } from "./compare.mjs";
import { ACCEPTED } from "./accepted.mjs";

export const SHARD_COUNT = 4;

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../..");
const baseline = JSON.parse(fs.readFileSync(path.join(here, "baseline.json"), "utf8"));

export function shardCells(shard) {
  return CELLS.filter((_, i) => i % SHARD_COUNT === shard);
}

// Once-only rows, registered by shard 0. A split that drops or doubles a cell would
// otherwise pass silently: each shard can only see its own slice.
function registerPartitionChecks() {
  test("the baseline covers every cell", () => {
    assert.deepEqual(Object.keys(baseline.cells).sort(), CELLS.map(cellName).sort());
  });

  test("every cell lands in exactly one shard", () => {
    const counts = new Map();
    for (let shard = 0; shard < SHARD_COUNT; shard++) {
      for (const cell of shardCells(shard)) counts.set(cell, (counts.get(cell) ?? 0) + 1);
    }
    assert.deepEqual(
      {
        missing: CELLS.filter((cell) => !counts.has(cell)).map(cellName),
        doubled: CELLS.filter((cell) => counts.get(cell) > 1).map(cellName),
      },
      { missing: [], doubled: [] },
    );
  });
}

// A cell whose waits were cut must match the baseline exactly: "no worse" would let a
// cut that changed an outcome pass, which is the whole risk of cutting a wait.
export function registerShard(shard) {
  if (shard === 0) registerPartitionChecks();
  for (const cell of shardCells(shard)) {
    const name = cellName(cell);
    test(`no worse than master ${baseline.ref}: ${name}`, async () => {
      const s = await startSession(root);
      let outcome;
      try {
        outcome = await runCell(s, cell);
      } finally {
        await s.stop();
      }
      if (CUT_WAIT_CELLS.includes(name)) {
        assert.deepEqual(outcome, baseline.cells[name], `a cut wait must not change the outcome: ${name}`);
        return;
      }
      const worse = regressions(outcome, baseline.cells[name])
        .filter((m) => !ACCEPTED.some((a) => a.cell === name && a.measure === m));
      assert.deepEqual(worse, [], `master: ${JSON.stringify(baseline.cells[name])}, here: ${JSON.stringify(outcome)}`);
    });
  }
}
