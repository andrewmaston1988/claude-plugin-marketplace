// The regression gate in CI: every lifecycle cell on this build, against master's
// outcomes saved in baseline.json by `gate.mjs --write-baseline`. A cell where this
// build is worse fails, unless the operator accepted it in accepted.mjs.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { startSession } from "./session-sim.mjs";
import { CELLS, cellName, runCell } from "./scenarios.mjs";
import { regressions } from "./compare.mjs";
import { ACCEPTED } from "./accepted.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../..");
const baseline = JSON.parse(fs.readFileSync(path.join(here, "baseline.json"), "utf8"));

test("the baseline covers every cell", () => {
  assert.deepEqual(Object.keys(baseline.cells).sort(), CELLS.map(cellName).sort());
});

for (const cell of CELLS) {
  const name = cellName(cell);
  test(`no worse than master ${baseline.ref}: ${name}`, async () => {
    const s = await startSession(root);
    let outcome;
    try {
      outcome = await runCell(s, cell);
    } finally {
      await s.stop();
    }
    const worse = regressions(outcome, baseline.cells[name])
      .filter((m) => !ACCEPTED.some((a) => a.cell === name && a.measure === m));
    assert.deepEqual(worse, [], `master: ${JSON.stringify(baseline.cells[name])}, here: ${JSON.stringify(outcome)}`);
  });
}
