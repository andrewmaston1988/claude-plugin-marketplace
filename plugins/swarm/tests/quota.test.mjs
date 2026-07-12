import { test } from "node:test";
import { equal, deepEqual, ok } from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  matchQuota, parseQuotaReset, parseUsageLimits, checkQuota, DEFAULT_QUOTA_PATTERNS,
} from "../src/quota.mjs";

// Trimmed from a live probe of the OAuth usage endpoint (2026-07-11).
const USAGE_FIXTURE = {
  limits: [
    { kind: "session", group: "session", percent: 22, severity: "normal", resets_at: "2026-07-11T12:19:59.817282+00:00", scope: null, is_active: true },
    { kind: "weekly_all", group: "weekly", percent: 2, severity: "normal", resets_at: "2026-07-18T07:59:59.817311+00:00", scope: null, is_active: false },
    { kind: "weekly_scoped", group: "weekly", percent: 4, severity: "normal", resets_at: "2026-07-18T07:59:59.817640+00:00", scope: { model: { display_name: "Fable" } }, is_active: false },
  ],
};

test("matchQuota: recognises Anthropic limit messages, not rate limits", () => {
  ok(matchQuota("Claude AI usage limit reached|1751210400", DEFAULT_QUOTA_PATTERNS));
  ok(matchQuota("You've hit your limit. Your limit will reset at 3pm", DEFAULT_QUOTA_PATTERNS));
  ok(matchQuota("out of extra usage credits", DEFAULT_QUOTA_PATTERNS));
  ok(!matchQuota("429 Too Many Requests: rate limit exceeded", DEFAULT_QUOTA_PATTERNS));
  ok(!matchQuota("segfault", DEFAULT_QUOTA_PATTERNS));
});

test("parseQuotaReset: epoch suffix, human phrasing, or null", () => {
  equal(parseQuotaReset("Claude AI usage limit reached|1751210400"), new Date(1751210400000).toISOString());
  equal(parseQuotaReset("Your limit will reset at 3pm (Europe/London)."), "3pm (Europe/London)");
  equal(parseQuotaReset("usage limit reached, resets at 2026-07-11T12:19:59Z"), "2026-07-11T12:19:59Z");
  equal(parseQuotaReset("segfault"), null);
});

test("parseUsageLimits: extracts limits with worst-by-percent", () => {
  const p = parseUsageLimits(USAGE_FIXTURE);
  equal(p.limits.length, 3);
  equal(p.worst.kind, "session");
  equal(p.worst.percent, 22);
  equal(p.worst.resetsAt, "2026-07-11T12:19:59.817282+00:00");
  equal(p.exhausted, false);
  const maxed = parseUsageLimits({ limits: [{ kind: "session", percent: 100, resets_at: "R" }] });
  equal(maxed.exhausted, true);
});

// A model-SCOPED limit constrains exactly one model — not the account. Treating it
// as account-wide exhaustion grounded every Claude leaf (Opus, Sonnet, Haiku) while
// the Fable-scoped weekly bucket sat at 100% and the unscoped buckets had headroom;
// the session doing the dispatch was itself running on Opus at the time.
test("parseUsageLimits: a model-scoped limit at 100% does NOT exhaust the account", () => {
  const p = parseUsageLimits({
    limits: [
      { kind: "session", percent: 24, resets_at: "R1", scope: null },
      { kind: "weekly_all", percent: 54, resets_at: "R2", scope: null },
      { kind: "weekly_scoped", percent: 100, resets_at: "R3", scope: { model: { display_name: "Fable" } } },
    ],
  });
  equal(p.exhausted, false);
  equal(p.worst.kind, "weekly_all", "worst-unscoped drives the account verdict");
  deepEqual(p.exhaustedScopes, [{ scope: "Fable", percent: 100, resetsAt: "R3" }]);
});

test("parseUsageLimits: an UNSCOPED limit at 100% DOES exhaust the account", () => {
  const p = parseUsageLimits({
    limits: [
      { kind: "session", percent: 12, resets_at: "R1", scope: null },
      { kind: "weekly_all", percent: 100, resets_at: "R2", scope: null },
      { kind: "weekly_scoped", percent: 3, resets_at: "R3", scope: { model: { display_name: "Fable" } } },
    ],
  });
  equal(p.exhausted, true);
  equal(p.worst.kind, "weekly_all");
  deepEqual(p.exhaustedScopes, []);
});

test("checkQuota: endpoint success is cached; second call within TTL skips fetch", async () => {
  const home = mkdtempSync(join(tmpdir(), "swarm-quota-"));
  try {
    const creds = join(home, "creds.json");
    writeFileSync(creds, JSON.stringify({ claudeAiOauth: { accessToken: "tok" } }));
    let fetches = 0;
    const fetchFn = async () => { fetches++; return { ok: true, status: 200, json: async () => USAGE_FIXTURE }; };
    const cfg = { quotaUsageUrl: "http://stub/usage" };
    const opts = { cfg, fetch: fetchFn, credentialsPath: creds, cachePath: join(home, "quota-cache.json"), now: () => 1000000 };

    const q1 = await checkQuota(opts);
    equal(q1.worst.percent, 22);
    equal(q1.source, "endpoint");
    equal(fetches, 1);
    ok(existsSync(opts.cachePath));

    const q2 = await checkQuota({ ...opts, now: () => 1000000 + 60_000 });
    equal(q2.source, "cache");
    equal(fetches, 1); // TTL 300s — no second fetch

    const q3 = await checkQuota({ ...opts, now: () => 1000000 + 301_000 });
    equal(q3.source, "endpoint");
    equal(fetches, 2); // TTL expired
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("checkQuota: best-effort null on missing creds or endpoint failure", async () => {
  const home = mkdtempSync(join(tmpdir(), "swarm-quota-"));
  try {
    const base = { cfg: {}, cachePath: join(home, "c.json"), now: () => 0 };
    equal(await checkQuota({ ...base, fetch: async () => { throw new Error("x"); }, credentialsPath: join(home, "missing.json") }), null);
    const creds = join(home, "creds.json");
    writeFileSync(creds, JSON.stringify({ claudeAiOauth: { accessToken: "tok" } }));
    equal(await checkQuota({ ...base, fetch: async () => ({ ok: false, status: 500 }), credentialsPath: creds }), null);
    ok(!existsSync(base.cachePath), "failures are never cached");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
