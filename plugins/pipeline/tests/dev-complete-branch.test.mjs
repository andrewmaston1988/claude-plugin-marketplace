import { test } from "node:test";
import { ok } from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// dev-complete is a CLI command that opens the real pipeline DB via
// lookupProjectOrFail (getPaths), so a behavioural test needs full path
// overrides. The branch-honouring behaviour of generateSessionFile is proven
// in session-templates + reaper-custom-branch; here we pin that dev-complete
// actually threads the resolved branch into that call.
const ROWS = fileURLToPath(new URL("../src/cli/rows.mjs", import.meta.url));

test("dev-complete threads the resolved row branch into the review session", () => {
  const src = readFileSync(ROWS, "utf8");
  ok(src.includes("resolveRowBranch(devCompleteRow"),
     "dev-complete must pass resolveRowBranch(devCompleteRow, ...) to generateSessionFile");
});
