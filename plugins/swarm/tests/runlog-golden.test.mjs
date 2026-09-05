// Goldens that pin the run.log → roster/glyph rendering across the parser split
// (src/runlog.mjs). The roster golden was captured on the unmodified code with
// CAPTURE_GOLDEN=1 and must never move. The glyph golden was recaptured once after
// the split, deliberately: the old glyph never saw expand/expand-manifest rows, so
// it under-counted pending by every clone and child; it now counts what the roster
// counts. Paths are normalised because the fixture lives in a temp dir.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { renderStatus } from "../src/results.mjs";
import { glyphFromLog } from "../statusline/swarm-glyph.mjs";
import { RUN_LOG, NOW, buildFixture } from "./fixtures/run-fixture.mjs";

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

test("golden: glyphFromLog over the fixture run.log is byte-stable", () => {
  const actual = glyphFromLog(RUN_LOG);
  if (process.env.CAPTURE_GOLDEN) {
    mkdirSync(FIXTURES, { recursive: true });
    writeFileSync(golden("glyph.golden.txt"), actual, "utf8");
  }
  assert.ok(existsSync(golden("glyph.golden.txt")), "golden captured");
  assert.equal(actual, readFileSync(golden("glyph.golden.txt"), "utf8"));
});
