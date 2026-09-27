import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { seedHome, withServer } from "./helpers/serve-fixture.mjs";

test("leaf endpoint: coverage status is exposed for an incomplete leaf", async () => {
  const { home, live } = seedHome();
  try {
    writeFileSync(join(live, "results", "find-a.json"), JSON.stringify({
      id: "find-a", model: "m", ok: true, output: "ten bullets",
      coverage: { status: "incomplete", required: 430, read: 3, missed: ["README.md"] },
    }), "utf8");
    await withServer({ home }, async ({ get }) => {
      const leaf = await get("/api/runs/C--code-a/live-1/leaves/find-a");
      assert.equal(leaf.status, 200);
      assert.equal(leaf.body.coverage.status, "incomplete");
      assert.equal(leaf.body.coverage.read, 3);
    });
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
