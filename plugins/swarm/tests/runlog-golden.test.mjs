// Golden that pins the run.log → roster rendering across the parser split
// (src/runlog.mjs). Captured on the unmodified code with CAPTURE_GOLDEN=1 and
// must never move. Paths are normalised because the fixture lives in a temp dir.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { renderStatus } from "../src/results.mjs";
import { NOW, buildFixture } from "./fixtures/run-fixture.mjs";

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "fixtures");
const QUIET_MS = 60_000;

function normalise(out, dir) {
  return out.split(dir).join("<dir>").replace(/\\/g, "/");
}

const golden = (name) => join(FIXTURES, name);

test("golden: renderStatus over the fixture run.log is byte-stable", () => {
  const home = mkdtempSync(join(tmpdir(), "swarm-golden-"));
  const dir = join(home, "fixture-1");
  const prevNoColor = process.env.NO_COLOR;
  process.env.NO_COLOR = "1";
  try {
    buildFixture(dir);
    writeFileSync(join(dir, "heartbeat"), "live\n"); // a live engine: status must not read it as dead
    const actual = normalise(renderStatus(dir, NOW, QUIET_MS), dir);
    if (process.env.CAPTURE_GOLDEN) {
      mkdirSync(FIXTURES, { recursive: true });
      writeFileSync(golden("renderStatus.golden.txt"), actual, "utf8");
    }
    assert.ok(existsSync(golden("renderStatus.golden.txt")), "golden captured (run once with CAPTURE_GOLDEN=1 on unmodified code)");
    assert.equal(actual, readFileSync(golden("renderStatus.golden.txt"), "utf8"));
  } finally {
    if (prevNoColor === undefined) delete process.env.NO_COLOR; else process.env.NO_COLOR = prevNoColor;
    rmSync(home, { recursive: true, force: true });
  }
});
