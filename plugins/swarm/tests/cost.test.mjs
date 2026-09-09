// Cost history — the banked weekly snapshots `swarm cost` derives multipliers
// from. Storage tests live here (line-atomic appends, torn tails); the
// derivation tests (week split, per-model cost, multipliers) are below and are
// ported field-for-field from the operator's cost-table arithmetic.
import { test } from "node:test";
import { equal, deepEqual, ok, throws, match } from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, appendFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  usageHistoryPath, appendSnapshot, readSnapshots,
} from "../src/cost.mjs";

function tmp() {
  return mkdtempSync(join(tmpdir(), "swarm-cost-"));
}

// ── storage ───────────────────────────────────────────────────────────────────

test("usageHistoryPath: derives from SWARM_HOME, never a hardcoded home", () => {
  match(usageHistoryPath({ SWARM_HOME: join("C:", "custom") }), /custom[\\/]usage-history\.jsonl$/);
});

test("appendSnapshot: creates a missing dir and appends one parseable line per snapshot", () => {
  const dir = tmp();
  try {
    const p = join(dir, "nested", "usage-history.jsonl");
    ok(!existsSync(p));
    appendSnapshot({ fetchedAt: 1, weeklyPctUsed: 40, weeklyModels: [] }, p);
    appendSnapshot({ fetchedAt: 2, weeklyPctUsed: 41, weeklyModels: [] }, p);
    const lines = readFileSync(p, "utf8").split("\n").filter(Boolean);
    equal(lines.length, 2, "two appends, two lines — one snapshot never straddles a line boundary");
    for (const l of lines) JSON.parse(l);
    equal(readSnapshots(p).length, 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// JSON escapes real newlines, so a snapshot's string values cannot break the
// one-line-one-snapshot invariant the concurrent-append safety rests on.
test("appendSnapshot: a string value containing a newline stays one line", () => {
  const dir = tmp();
  try {
    const p = join(dir, "usage-history.jsonl");
    appendSnapshot({ fetchedAt: 1, note: "a\nb" }, p);
    equal(readSnapshots(p).length, 1);
    equal(readSnapshots(p)[0].note, "a\nb");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("readSnapshots: a torn tail line is skipped rather than aborting the query", () => {
  const dir = tmp();
  try {
    const p = join(dir, "usage-history.jsonl");
    appendSnapshot({ fetchedAt: 1, weeklyModels: [] }, p);
    appendSnapshot({ fetchedAt: 2, weeklyModels: [] }, p);
    appendFileSync(p, `{"fetchedAt":3${String.fromCharCode(10)}`);
    equal(readSnapshots(p).length, 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("readSnapshots: a missing file reads as empty, never throws", () => {
  deepEqual(readSnapshots(join(tmpdir(), "swarm-cost-no-such", "usage-history.jsonl")), []);
});