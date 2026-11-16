// Test files no suite runs. A test that is never executed is a green CI that
// proves nothing, so the whole repository is walked -- not just the directories
// the suites happen to name -- with the same walker glob expansion uses.

import * as nodeFs from "node:fs";

import { SKIP_DIRS, expandRun, walkFrom } from "./select.mjs";

const TEST_FILE = /\.test\.(?:mjs|js)$/;

/** A fixture tree holds data a test reads, never a test of its own. */
const ORPHAN_SKIP_DIRS = new Set([...SKIP_DIRS, "fixtures"]);

/** Every `*.test.mjs`/`*.test.js` under `repoRoot` that no suite's globs expand
 *  to and `notRun` does not list, sorted. `notRun` entries are
 *  `{ path, reason }`. */
export function orphanTests(suites, { repoRoot, notRun = [], _readdirSync = nodeFs.readdirSync } = {}) {
  const covered = new Set();
  for (const suite of suites) {
    for (const run of suite.runs) {
      for (const file of expandRun(run, { repoRoot, _readdirSync })) covered.add(file);
    }
  }
  const exempt = new Set(notRun.map((entry) => entry.path));
  const files = [];
  walkFrom(repoRoot, "", files, _readdirSync, ORPHAN_SKIP_DIRS);
  return files.filter((file) => TEST_FILE.test(file) && !covered.has(file) && !exempt.has(file)).sort();
}
