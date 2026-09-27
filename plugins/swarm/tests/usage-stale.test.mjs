// What a reading this process did not fetch prints: the /!\ banner above the
// figures, and the age mark that rides the figure itself. Split from
// usage.test.mjs, which is over the 500-line bar.
import { test } from "node:test";
import { equal, deepEqual, ok } from "node:assert/strict";
import { join } from "node:path";
import { normalizeCodex, normalizeOllama, notableLines, usageLines } from "../src/usage.mjs";

const LONDON = "Europe/London";

const OLLAMA_OK = {
  state: "ok",
  sessionPctUsed: 12, sessionResetsAt: "2026-09-06T12:00:00Z",
  weeklyPctUsed: 83.8, resetsAt: "2026-09-12T08:00:00Z",
};

// Test 3 — the timestamp is absolute UTC, never an age. A "33h ago" reading is
// what told nobody the figure was old; an ISO stamp lets the operator judge.
test("notableLines: G7b the cached banner stamps last-seen in absolute UTC — the word 'ago' is gone", () => {
  const lastSeen = Date.parse("2026-09-08T14:49:00Z");
  const u = normalizeOllama({
    ...OLLAMA_OK, provenance: "cached", reason: "expired-cookie",
    lastSeen, cookiePath: join("home", "ollama-cookie.json"),
  });
  const lines = notableLines([u]);
  const stamp = new Date(lastSeen).toISOString();
  ok(lines.some((l) => l.includes(`last seen: ${stamp}`)), lines.join("\n"));
  ok(!lines.some((l) => l.includes("ago")), `'ago' must never print: ${lines.join("\n")}`);
  // the figures themselves keep their own absolute reset stamps
  deepEqual(usageLines([u], { timeZone: LONDON }).filter((l) => l.startsWith("ollama weekly")), ["ollama weekly: 83.8% — resets Sat 12 Sep, 09:00"]);
});

// Test 4 — every failure reason names itself; a healthy cached reading is silent.
test("notableLines: G7c each failure reason prints its own /!\\ title above a Refresh line", () => {
  const cases = [
    ["no-cookie", "No Cookie"],
    ["expired-cookie", "Cookie Expired"],
    ["network-error", "Network Error"],
    ["timeout", "Fetch Timed Out"],
    ["unparseable", "Page Unreadable"],
  ];
  for (const [reason, title] of cases) {
    const u = normalizeOllama({ ...OLLAMA_OK, provenance: "cached", reason, cookiePath: "cp" });
    const lines = notableLines([u]);
    ok(lines[0].startsWith(`/!\\ ${title} — figures below are cached.`), `${reason}: ${lines.join(" | ")}`);
    ok(lines.some((l) => l.includes("swarm ollama-usage --cookie")), `${reason} must name the fix: ${lines.join(" | ")}`);
  }
  // the same reading with NO recorded reason is healthy — exact-output callers stay quiet
  deepEqual(notableLines([normalizeOllama({ ...OLLAMA_OK, provenance: "cached", reason: null })]), []);
});

// A stale reading is not a cached one: someone asked for a refresh and the
// provider did not answer, so the banner says that instead of "figures below are
// cached" — and the mark rides the figure, not only the banner.
test("notableLines: G7e a stale reading gets its own banner, not the cached one", () => {
  const now = Date.parse("2026-09-08T15:00:00Z");
  const u = normalizeOllama({ ...OLLAMA_OK, provenance: "stale", reason: "expired-cookie", lastSeen: Date.parse("2026-09-08T14:49:00Z"), cookiePath: "cp" });
  const lines = notableLines([u], { now });
  ok(lines[0].startsWith("/!\\ Cookie Expired — figures below are the last reading"), lines.join("\n"));
  ok(lines[0].includes("stale · read 11m ago"), lines.join("\n"));
  ok(!/\d{4}-\d{2}-\d{2}T/.test(lines[0]), `an age, not an ISO stamp: ${lines[0]}`);
  ok(!lines[0].includes("figures below are cached"), lines[0]);
});

// The shared cache's stale shape: a provenance and the moment it was read, and
// no failure note at all — a refresh that simply did not answer records no
// reason of its own. Suppressing the banner over a missing reason left the one
// reading the reader must not trust as the only reading that said nothing.
test("notableLines: G7f a stale reading with no recorded reason still banners, and carries its age", () => {
  const now = Date.parse("2026-09-08T15:00:00Z");
  const u = normalizeCodex({
    provider: "codex",
    buckets: [{ kind: "rate-limit", limitId: "session", primary: { usedPercent: 42 } }],
    provenance: "stale",
    fetchedAt: now - 12 * 60_000,
  });
  const lines = notableLines([u], { now });
  ok(lines.length, "a stale reading must never print nothing");
  ok(lines[0].startsWith("/!\\ Usage Unread — figures below are the last reading"), lines.join("\n"));
  ok(lines[0].includes("stale · read 12m ago"), lines.join("\n"));
  ok(!/\d{4}-\d{2}-\d{2}T/.test(lines[0]), `an age, not an ISO stamp: ${lines[0]}`);
  // the age rides the figure too, not only the banner above it
  ok(usageLines([u], { now }).some((l) => l.endsWith(" · stale · read 12m ago")), usageLines([u], { now }).join("\n"));
});

// The mark rides the figure, not only the banner: a reading past its TTL that
// this process did not fetch says so on the line the reader takes the number
// from, and says how old it is — "stale" alone does not say whether to act.
test("usageLines: G7d a stale reading prints `stale · read <age> ago`; cached and live do not", () => {
  const now = Date.parse("2026-09-08T15:00:00Z");
  const line = (over) => usageLines([normalizeOllama({ ...OLLAMA_OK, ...over })], { timeZone: LONDON, now })
    .find((l) => l.startsWith("ollama weekly"));
  const figures = "ollama weekly: 83.8% — resets Sat 12 Sep, 09:00";

  equal(line({ provenance: "stale", lastSeen: now - 12 * 60_000 }), `${figures} · stale · read 12m ago`);
  equal(line({ provenance: "stale", lastSeen: now - 3 * 3_600_000 }), `${figures} · stale · read 3h ago`);
  equal(line({ provenance: "cached", lastSeen: now - 60_000 }), figures, "a fresh cache read is not marked");
  equal(line({ provenance: "live" }), figures);
  equal(line({ provenance: "stale", lastSeen: null }), figures, "no banked age, no claim about one");
});
