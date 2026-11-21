import "./helpers/isolate-home.mjs";
import { test } from "node:test";
import { ok } from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expandRun, skipDirsFor } from "@andrewmaston1988/test-runner";
import config from "../../../test-runner.config.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..", "..", "..");
const HELPER = join(repoRoot, "plugins", "pipeline", "tests", "helpers", "isolate-home.mjs");

// Every file the pipeline suite actually runs, read off the config rather than
// re-globbed here — a new glob in test-runner.config.mjs is covered for free.
function suiteFiles() {
  const files = new Set();
  const skipDirs = skipDirsFor(config);
  for (const run of config.suites.find((suite) => suite.name === "pipeline").runs) {
    for (const file of expandRun(run, { repoRoot, skipDirs })) files.add(file);
  }
  return [...files].sort();
}

function firstImport(file) {
  const source = readFileSync(join(repoRoot, file), "utf8");
  const match = /^import\s+(?:[^"']*?\bfrom\s+)?["']([^"']+)["']/m.exec(source);
  return match ? match[1] : null;
}

test("every pipeline suite file imports the isolate-home helper first", () => {
  const files = suiteFiles();
  ok(files.length > 0, "the pipeline suite's globs matched no files");
  const offenders = [];
  for (const file of files) {
    const spec = firstImport(file);
    // Resolve rather than string-compare: "helpers/…" from tests/ and
    // "../../tests/helpers/…" from src/ are both fine; a wrong target is not.
    const resolved = spec?.startsWith(".") ? resolve(dirname(join(repoRoot, file)), spec) : null;
    if (resolved !== HELPER) offenders.push(`${file}: first import is ${spec ?? "(none)"}`);
  }
  ok(offenders.length === 0, `pipeline tests must isolate home first:\n  ${offenders.join("\n  ")}`);
});
