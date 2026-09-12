import { test } from "node:test";
import { equal, ok, deepEqual } from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  normalizeAnthropic, normalizeOllama, readCachedUsage, usageLines, notableLines,
  formatResetTime, QUOTA_CACHE_FILENAME,
} from "../src/usage.mjs";

const LONDON = "Europe/London";

const ANTHROPIC = {
  limits: [
    { kind: "session", percent: 42, resetsAt: "2026-09-06T12:00:00Z", scope: null },
    { kind: "weekly_all", percent: 71, resetsAt: "2026-09-12T00:00:00Z", scope: null },
    { kind: "weekly", percent: 100, resetsAt: "2026-09-12T00:00:00Z", scope: "Opus" },
  ],
  exhausted: false,
};

const OLLAMA_OK = {
  state: "ok",
  sessionPctUsed: 12, sessionResetsAt: "2026-09-06T12:00:00Z",
  weeklyPctUsed: 83.8, resetsAt: "2026-09-12T08:00:00Z",
};

// ---- normalize: both providers arrive in ONE shape ------------------------

test("normalizeAnthropic: G1 carries every limit window, scope included", () => {
  const u = normalizeAnthropic(ANTHROPIC);
  equal(u.provider, "anthropic");
  equal(u.state, "ok");
  equal(u.limits.length, 3);
  equal(u.limits[2].scope, "Opus", "a per-model bucket keeps its scope");
});

test("normalizeAnthropic: G2 exhausted is the account verdict, not a per-limit one", () => {
  equal(normalizeAnthropic({ ...ANTHROPIC, exhausted: true }).state, "exhausted");
  // A scoped 100% alone must NOT read as exhausted — that conflation grounded
  // every Claude leaf whenever one premium model's bucket filled.
  equal(normalizeAnthropic(ANTHROPIC).state, "ok");
});

test("normalizeOllama: G3 session AND weekly both survive normalisation", () => {
  const u = normalizeOllama(OLLAMA_OK);
  equal(u.provider, "ollama");
  deepEqual(u.limits.map((l) => l.kind), ["session", "weekly"]);
  equal(u.limits[0].percent, 12);
  equal(u.limits[1].percent, 83.8);
  equal(u.limits[1].resetsAt, "2026-09-12T08:00:00Z");
});

test("normalizeOllama/Anthropic: G4 an unreadable provider is `unknown` with no limits", () => {
  for (const u of [normalizeOllama({ state: "unknown" }), normalizeOllama(null), normalizeAnthropic(null), normalizeAnthropic({ limits: [] })]) {
    equal(u.state, "unknown");
    deepEqual(u.limits, []);
  }
});

// ---- the printed lines ----------------------------------------------------

test("usageLines: G5 every provider prints the same shape, provider-named", () => {
  const lines = usageLines([normalizeAnthropic(ANTHROPIC), normalizeOllama(OLLAMA_OK)], { timeZone: LONDON });
  ok(lines.includes("anthropic session: 42% — resets Sun 6 Sep, 13:00"), lines.join("\n"));
  ok(lines.includes("ollama weekly: 83.8% — resets Sat 12 Sep, 09:00"), lines.join("\n"));
  ok(lines.some((l) => l.startsWith("anthropic weekly (Opus):")), lines.join("\n"));
});

test("notableLines: G6 a healthy provider says NOTHING", () => {
  deepEqual(notableLines([normalizeAnthropic(ANTHROPIC), normalizeOllama(OLLAMA_OK)]), []);
});

test("notableLines: G7 exhaustion and a full session bar each get one line", () => {
  const exhausted = notableLines([normalizeOllama({ ...OLLAMA_OK, state: "exhausted", weeklyPctUsed: 100 })]);
  ok(exhausted[0].startsWith("ollama: weekly allowance exhausted"), exhausted[0]);

  // Weekly healthy, session full: blocked NOW, and only this line says so.
  const session = notableLines([normalizeOllama({ ...OLLAMA_OK, sessionPctUsed: 100 })]);
  ok(session[0].startsWith("ollama: session limit reached"), session[0]);
});

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

test("notableLines: G8 anthropic exhaustion is reported the same way as a cloud provider's", () => {
  const lines = notableLines([normalizeAnthropic({ ...ANTHROPIC, exhausted: true })]);
  ok(lines[0].startsWith("anthropic: weekly allowance exhausted"), lines[0]);
});

// ---- readCachedUsage: the only function that touches disk -----------------

// `await fn` matters: without it the finally tears the directory down before
// the async body has written anything into it.
async function withHome(fn) {
  const home = mkdtempSync(join(tmpdir(), "swarm-usage-"));
  try {
    return await fn(home);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

const NOW = 2_000_000_000_000;
const stubOllama = (reading) => ({ usageFromCache: () => reading });

test("readCachedUsage: G9 a fresh anthropic cache is read; an EXPIRED one is unknown, never stale", async () => {
  await withHome(async (home) => {
    const cachePath = join(home, QUOTA_CACHE_FILENAME);
    writeFileSync(cachePath, JSON.stringify({ ts: NOW - 1000, result: ANTHROPIC }));
    const fresh = await readCachedUsage({}, { now: NOW, cachePath });
    equal(fresh[0].state, "ok");

    // Past the 300s TTL. The CLI refetches unprompted, so a warning here would
    // be noise — `unknown`, and notableLines stays silent about it.
    writeFileSync(cachePath, JSON.stringify({ ts: NOW - 400_000, result: ANTHROPIC }));
    const expired = await readCachedUsage({}, { now: NOW, cachePath });
    equal(expired[0].state, "unknown");
    deepEqual(notableLines(expired), []);
  });
});

test("readCachedUsage: G10 ollama appears only when enabled", async () => {
  await withHome(async (home) => {
    const cachePath = join(home, QUOTA_CACHE_FILENAME);
    const off = await readCachedUsage({}, { now: NOW, cachePath, _ollama: stubOllama(OLLAMA_OK) });
    deepEqual(off.map((u) => u.provider), ["anthropic"]);

    const cfg = { provider: { cloud: { ollama: { enabled: true } } } };
    const on = await readCachedUsage(cfg, { now: NOW, cachePath, _ollama: stubOllama(OLLAMA_OK) });
    deepEqual(on.map((u) => u.provider), ["anthropic", "ollama"]);
  });
});

test("readCachedUsage: G11 never throws — missing cache, corrupt cache, a provider that blows up", async () => {
  await withHome(async (home) => {
    const missing = await readCachedUsage({}, { now: NOW, cachePath: join(home, "nope.json") });
    equal(missing[0].state, "unknown");

    const corrupt = join(home, QUOTA_CACHE_FILENAME);
    writeFileSync(corrupt, "{not json");
    equal((await readCachedUsage({}, { now: NOW, cachePath: corrupt }))[0].state, "unknown");

    const cfg = { provider: { cloud: { ollama: { enabled: true } } } };
    const blowsUp = { usageFromCache: () => { throw new Error("boom"); } };
    const out = await readCachedUsage(cfg, { now: NOW, cachePath: corrupt, _ollama: blowsUp });
    deepEqual(out.map((u) => u.state), ["unknown", "unknown"]);
  });
});

// ---- formatResetTime: local time, no arithmetic ----------------------------

test("formatResetTime: R1 an absolute instant reads in the reader's own zone, no seconds", () => {
  equal(formatResetTime("2026-09-12T08:00:00.490024+00:00", { timeZone: LONDON }), "Sat 12 Sep, 09:00");
});

test("formatResetTime: R2 the same instant in UTC differs from London BST; winter shows GMT", () => {
  equal(formatResetTime("2026-09-12T08:00:00.490024+00:00", { timeZone: "UTC" }), "Sat 12 Sep, 08:00");
  // 12 Jan is outside BST (last Sun Mar -> last Sun Oct) — London stays on GMT, no +1h.
  equal(formatResetTime("2026-01-12T08:00:00Z", { timeZone: LONDON }), "Mon 12 Jan, 08:00");
});

test("usageLines: R3 prints '— resets <formatted>' and keeps the raw ISO in the data", () => {
  const u = normalizeOllama(OLLAMA_OK);
  const lines = usageLines([u], { timeZone: LONDON });
  ok(lines.includes("ollama weekly: 83.8% — resets Sat 12 Sep, 09:00"), lines.join("\n"));
  // rendering only — the data structure still carries the raw ISO instant.
  equal(u.limits.find((l) => l.kind === "weekly").resetsAt, "2026-09-12T08:00:00Z");
});

test("notableLines: R4 weekly-exhausted and session-limit lines use the same formatter", () => {
  const exhausted = notableLines([normalizeOllama({ ...OLLAMA_OK, state: "exhausted", weeklyPctUsed: 100 })], { timeZone: LONDON });
  equal(exhausted[0], "ollama: weekly allowance exhausted, resets Sat 12 Sep, 09:00");

  const session = notableLines([normalizeOllama({ ...OLLAMA_OK, sessionPctUsed: 100 })], { timeZone: LONDON });
  equal(session[0], "ollama: session limit reached, resets Sun 6 Sep, 13:00");
});

test("formatResetTime: R5 a missing or unparseable resetsAt prints no clause, never throws", () => {
  equal(formatResetTime(null), null);
  equal(formatResetTime(undefined), null);
  equal(formatResetTime("not-a-date"), null);

  const missing = normalizeOllama({ ...OLLAMA_OK, sessionResetsAt: undefined, resetsAt: "garbage" });
  const lines = usageLines([missing], { timeZone: LONDON });
  ok(lines.every((l) => !l.includes("resets")), lines.join("\n"));

  const exhausted = notableLines([normalizeOllama({ ...OLLAMA_OK, state: "exhausted", weeklyPctUsed: 100, resetsAt: "garbage" })], { timeZone: LONDON });
  equal(exhausted[0], "ollama: weekly allowance exhausted");
});
