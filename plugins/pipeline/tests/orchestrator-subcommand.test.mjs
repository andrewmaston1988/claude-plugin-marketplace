import { test } from "node:test";
import { ok, strictEqual } from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const BIN = fileURLToPath(new URL("../bin/pipeline.mjs", import.meta.url));

test("bin/pipeline.mjs has orchestrator/orchestrate subcommand", () => {
  const src = readFileSync(BIN, "utf8");
  ok(
    src.includes('cmd === "orchestrator" || cmd === "orchestrate"'),
    'should check for "orchestrator" or "orchestrate" command'
  );
});

test("orchestrator subcommand imports scripts/orchestrator/index.mjs", () => {
  const src = readFileSync(BIN, "utf8");
  ok(
    src.includes("scripts/orchestrator/index.mjs"),
    "should import scripts/orchestrator/index.mjs"
  );
  // Verify the import is inside the orchestrator subcommand block
  const orchBlock = src.slice(
    src.indexOf('cmd === "orchestrator"'),
    src.indexOf('cmd === "orchestrator"') + 300
  );
  ok(orchBlock.includes("await import("), "should use dynamic import");
  ok(orchBlock.includes("return;"), "should return after import so daemon owns the event loop");
});
