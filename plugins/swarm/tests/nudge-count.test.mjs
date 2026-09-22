import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { NUDGE_CAP, firedCount, underCap, recordFiring } from "../hooks/nudge-count.mjs";

function tmpMarker() {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), "nudge-")), "nested", ".seen.json");
}

test("counts a missing or unknown session as zero", () => {
  assert.equal(firedCount(null, "s1"), 0);
  assert.equal(firedCount({}, "s1"), 0);
  assert.equal(firedCount({ s2: { n: 3 } }, "s1"), 0);
  assert.equal(firedCount({ s1: { n: "many" } }, "s1"), 0);
});

// workflow-nudge wrote a bare timestamp when it was a once-per-session hook. Upgrading
// mid-session must not hand the operator a fresh budget, so that shape reads as one firing.
test("legacy bare-timestamp entries read as one firing", () => {
  assert.equal(firedCount({ s1: 1234567890 }, "s1"), 1);
  assert.equal(underCap({ s1: 1234567890 }, "s1"), NUDGE_CAP > 1);
});

test("underCap is exclusive of the cap", () => {
  assert.equal(underCap({ s1: { n: NUDGE_CAP - 1 } }, "s1"), true);
  assert.equal(underCap({ s1: { n: NUDGE_CAP } }, "s1"), false);
  assert.equal(underCap({ s1: { n: NUDGE_CAP + 5 } }, "s1"), false);
  assert.equal(underCap({ s1: { n: 0 } }, "s1", 0), false);
});

test("recordFiring increments, creating the file and its directory", () => {
  const file = tmpMarker();
  recordFiring(file, "s1");
  assert.equal(firedCount(JSON.parse(fs.readFileSync(file, "utf8")), "s1"), 1);
  recordFiring(file, "s1");
  assert.equal(firedCount(JSON.parse(fs.readFileSync(file, "utf8")), "s1"), 2);
  recordFiring(file, "s2");
  const seen = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.equal(firedCount(seen, "s1"), 2);
  assert.equal(firedCount(seen, "s2"), 1);
});

test("recordFiring upgrades a legacy entry rather than restarting it", () => {
  const file = tmpMarker();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ s1: Date.now() }), "utf8");
  recordFiring(file, "s1");
  assert.equal(firedCount(JSON.parse(fs.readFileSync(file, "utf8")), "s1"), 2);
});

test("recordFiring prunes entries older than a day", () => {
  const file = tmpMarker();
  const now = Date.now();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({
    stale: { n: 1, t: now - 86_400_001 },
    legacyStale: now - 86_400_001,
    fresh: { n: 1, t: now },
  }), "utf8");
  recordFiring(file, "s1", { now });
  const seen = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.deepEqual(Object.keys(seen).sort(), ["fresh", "s1"]);
});

// Nudging matters more than remembering we nudged — an unwritable marker must not throw.
test("recordFiring swallows a write failure", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nudge-"));
  const file = path.join(dir, "blocked");
  fs.writeFileSync(file, "not a directory", "utf8");
  assert.doesNotThrow(() => recordFiring(path.join(file, "seen.json"), "s1"));
});
