// Child run by tests/isolate-home-coverage.test.mjs: one test that writes 2 MB to
// a temp dir it makes itself, the way most of the suite does. Run with an outer
// temp dir of its own, nothing it leaves behind may land there.
import "../helpers/isolate-home.mjs";
import { test } from "node:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("writes into a temp dir of its own", () => {
  const dir = mkdtempSync(join(tmpdir(), "leak-"));
  writeFileSync(join(dir, "big.txt"), "x".repeat(2 * 1024 * 1024));
});
