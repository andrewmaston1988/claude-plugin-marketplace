import { test } from "node:test";
import { ok } from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const WIZARD = fileURLToPath(new URL("../src/setup/wizard.mjs", import.meta.url));

test("wizard Step 8 uses pipeline-resolver.mjs path when building dispatch target", () => {
  const src = readFileSync(WIZARD, "utf8");
  ok(
    src.includes("pipeline-resolver.mjs"),
    "should reference pipeline-resolver.mjs for the resolver path"
  );
  ok(
    src.includes("orchestrator"),
    "should include 'orchestrator' subcommand in dispatch target"
  );
});

test("wizard Step 8 falls back to pinned entry when resolver absent", () => {
  const src = readFileSync(WIZARD, "utf8");
  ok(
    src.includes("scripts/orchestrator/index.mjs"),
    "should retain pinned orchestrator entry as fallback"
  );
  ok(
    src.includes("existsSync(resolverPath)"),
    "should gate resolver use on existsSync check"
  );
});

test("wizard Step 8 passes dispatchTarget as bridgeEntry to renderTemplate", () => {
  const src = readFileSync(WIZARD, "utf8");
  ok(
    src.includes("bridgeEntry: dispatchTarget"),
    "should pass dispatchTarget as bridgeEntry to renderTemplate"
  );
});
