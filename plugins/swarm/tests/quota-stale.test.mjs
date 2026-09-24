// A refused usage fetch (429) must not blank the reading: the last good one is served,
// and the endpoint's Retry-After is honoured so the dashboard stops extending the 429.
import { test } from "node:test";
import { equal, ok } from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { checkQuota } from "../src/quota.mjs";

const LIMITS = { limits: [
  { kind: "session", percent: 40, resets_at: "2026-09-24T21:00:00Z", scope: null },
  { kind: "weekly_all", percent: 93, resets_at: "2026-09-26T08:00:00Z", scope: null },
] };
const T0 = Date.parse("2026-09-24T17:00:00Z");

function setup() {
  const home = mkdtempSync(join(tmpdir(), "swarm-quota-stale-"));
  const creds = join(home, "creds.json");
  writeFileSync(creds, JSON.stringify({ claudeAiOauth: { accessToken: "tok" } }));
  let fetches = 0, reply = { ok: true, status: 200, json: async () => LIMITS };
  const opts = (nowMs) => ({ cfg: {}, credentialsPath: creds, cachePath: join(home, "q.json"), now: () => nowMs,
    fetch: async () => { fetches++; return reply; } });
  return { home, opts, setReply: (r) => { reply = r; }, fetches: () => fetches };
}
const tooMany = (secs) => ({ ok: false, status: 429, headers: { get: (h) => (h.toLowerCase() === "retry-after" ? String(secs) : null) } });

test("a 429 past the TTL serves the last good reading, marked stale", async () => {
  const s = setup();
  try {
    await checkQuota(s.opts(T0));
    s.setReply(tooMany(3600));
    const q = await checkQuota(s.opts(T0 + 30 * 60_000));
    ok(q, "the last reading, not null");
    equal(q.source, "stale");
    equal(q.asOfMs, T0);
    equal(q.worst.percent, 93);
  } finally { rmSync(s.home, { recursive: true, force: true }); }
});

test("Retry-After is honoured: no refetch until it elapses", async () => {
  const s = setup();
  try {
    await checkQuota(s.opts(T0));
    s.setReply(tooMany(3600));
    await checkQuota(s.opts(T0 + 10 * 60_000));
    equal(s.fetches(), 2);
    await checkQuota(s.opts(T0 + 20 * 60_000));
    equal(s.fetches(), 2, "inside the Retry-After window");
    s.setReply({ ok: true, status: 200, json: async () => LIMITS });
    const q = await checkQuota(s.opts(T0 + 10 * 60_000 + 3601_000));
    equal(s.fetches(), 3);
    equal(q.source, "endpoint");
  } finally { rmSync(s.home, { recursive: true, force: true }); }
});

test("a stale bucket whose reset has passed reads as refilled", async () => {
  const s = setup();
  try {
    await checkQuota(s.opts(T0));
    s.setReply(tooMany(60));
    const q = await checkQuota(s.opts(Date.parse("2026-09-24T22:00:00Z")));
    equal(q.limits.find((l) => l.kind === "session").percent, 0);
    equal(q.limits.find((l) => l.kind === "weekly_all").percent, 93);
  } finally { rmSync(s.home, { recursive: true, force: true }); }
});

test("the Claude adapter reports a held-over reading as provenance stale, dated when it was read", async () => {
  const { readClaudeUsage } = await import("../src/claude-usage.mjs");
  const snap = await readClaudeUsage({ usageOptIn: true, now: T0 + 60 * 60_000,
    quotaCheck: async () => ({ limits: [{ kind: "session", percent: 40 }], source: "stale", asOfMs: T0 }) });
  equal(snap.provenance, "stale");
  equal(snap.asOf, new Date(T0).toISOString());
});
