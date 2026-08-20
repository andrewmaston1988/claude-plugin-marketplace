// pipeline-query.test.mjs — rowField unit tests.
//
// Replaces the inline `node -e` JSON parser the merge SKILL.md transcribed three
// times (Steps 1.5 / 2.4 / 2.5). The old idiom swallowed every failure into an
// empty string, so a malformed row and an absent field were indistinguishable
// from a legitimately blank value. These tests pin the distinction.
import { test } from "node:test";
import { equal } from "node:assert/strict";
import { rowField } from "./pipeline-query.mjs";

test("rowField: reads a field from the first row", () => {
  equal(rowField('[{"target_branch":"develop"}]', "target_branch"), "develop");
});

test("rowField: absent field is null, not empty string", () => {
  equal(rowField('[{"other":"x"}]', "target_branch"), null);
});

test("rowField: empty result set is null", () => {
  equal(rowField("[]", "target_branch"), null);
});

test("rowField: malformed JSON is null, never throws", () => {
  equal(rowField("{not json", "target_branch"), null);
});

test("rowField: empty stdin is null", () => {
  equal(rowField("", "target_branch"), null);
});

// The three call sites differ only in which field they read; a shared helper is
// only correct if it does not special-case any of them.
test("rowField: reads rebase_required as a raw value", () => {
  equal(rowField('[{"rebase_required":1}]', "rebase_required"), 1);
});

test("rowField: reads plan_file", () => {
  equal(rowField('[{"plan_file":"/p/plans/x.md"}]', "plan_file"), "/p/plans/x.md");
});

// A blank stored value is a real value and must survive as one — the merge
// target-branch fallback keys on null, so coercing "" to null would silently
// change which branch a merge targets.
test("rowField: stored empty string stays an empty string", () => {
  equal(rowField('[{"target_branch":""}]', "target_branch"), "");
});

test("rowField: null field stays null", () => {
  equal(rowField('[{"target_branch":null}]', "target_branch"), null);
});

test("rowField: non-array JSON is null", () => {
  equal(rowField('{"target_branch":"develop"}', "target_branch"), null);
});
