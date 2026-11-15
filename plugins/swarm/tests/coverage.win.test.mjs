// The win32 half of the coverage checker: path matching is case-insensitive and
// separator-normalised there, and only there.
//
// Its own file so the diff-aware Windows run always exercises it, not only when
// something in coverage.test.mjs's closure changed.
import "./helpers/isolate-home.mjs";
import { test } from "node:test";
import { equal } from "node:assert/strict";
import { checkCoverage } from "../src/coverage.mjs";

const req = (path, ranges, whole = false) => ({ path, ranges, whole });

test("checkCoverage: path match is case-insensitive + separator-normalised on win32 (namesEqual)", () => {
  if (process.platform !== "win32") return;
  const cov = checkCoverage([req("C:\\a\\b.md", [[1, 10]])], [{ file: "C:/a/b.md", offset: 1, limit: 10 }]);
  equal(cov.status, "complete"); // mutation: strict string compare on win32
});
