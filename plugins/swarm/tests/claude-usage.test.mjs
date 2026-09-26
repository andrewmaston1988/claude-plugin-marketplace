// readClaudeUsage — the Claude adapter's usage surface. Anthropic was the one
// provider read outside the registry (special-cased by id in usage.mjs and
// scripts/swarm.mjs); these rows pin the canonical readUsage shape it now
// returns, so the skips can come out.
//
// Every row asserts on the CONTRACT-VALIDATED return — readClaudeUsage builds
// through `providerUsageSnapshot`, which validates and strips. A snapshot
// carrying `worst`/`exhaustedScopes`/`limits` (checkQuota's raw shape) fails the
// strip assertions even when every field reads right.
import { test } from "node:test";
import { equal, ok } from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { readClaudeUsage } from "../src/claude-usage.mjs";

const NOW = 1_758_400_000_000;

// checkQuota's return shape: parseUsageLimits' output plus `source`. `worst`
// and `exhaustedScopes` ride along in production; the snapshot must strip them.
const EXHAUSTED = {
  limits: [
    { kind: "session", percent: 100, severity: "exceeded", resetsAt: "2026-09-21T16:00:00Z", scope: null },
    { kind: "weekly_all", percent: 71, severity: null, resetsAt: "2026-09-27T00:00:00Z", scope: null },
  ],
  worst: { kind: "session", percent: 100 },
  exhausted: true,
  exhaustedScopes: [],
};

const HEADROOM = {
  limits: [
    { kind: "session", percent: 42, severity: null, resetsAt: "2026-09-21T16:00:00Z", scope: null },
    { kind: "weekly_all", percent: 71, severity: null, resetsAt: "2026-09-27T00:00:00Z", scope: null },
    { kind: "weekly", percent: 100, severity: "exceeded", resetsAt: "2026-09-27T00:00:00Z", scope: "Opus" },
  ],
  worst: { kind: "weekly_all", percent: 71 },
  exhausted: false,
  exhaustedScopes: [{ scope: "Opus", percent: 100, resetsAt: "2026-09-27T00:00:00Z" }],
};

function tmpHome() {
  return mkdtempSync(join(tmpdir(), "swarm-claude-usage-"));
}

test("readClaudeUsage: a live 100% account reading returns the contract-validated snapshot, exhausted", async () => {
  const home = tmpHome();
  try {
    const snap = await readClaudeUsage({
      env: { SWARM_HOME: home },
      now: () => NOW,
      usageOptIn: true,
      quotaCheck: async () => ({ ...structuredClone(EXHAUSTED), source: "endpoint" }),
    });
    equal(snap.provider, "claude");
    equal(snap.source, "anthropic-oauth-usage");
    equal(snap.provenance, "live");
    equal(snap.exhausted, true, "the account verdict rides the snapshot");
    ok(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(snap.asOf), `asOf is an ISO instant, got ${JSON.stringify(snap.asOf)}`);
    ok(!("worst" in snap) && !("exhaustedScopes" in snap) && !("limits" in snap),
      `record() strips fields outside the contract, got keys ${Object.keys(snap).join(", ")}`);
    ok(snap.buckets.some((b) => b.kind === "session" && b.percent === 100), JSON.stringify(snap.buckets));
    ok(snap.buckets.every((b) => !("severity" in b)), "checkQuota's severity field does not survive the wrap");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

// The off-by-one and truthiness traps: 99% must read false, and the field must
// be a real boolean when known — the gate reads `usage?.exhausted` verbatim.
test("readClaudeUsage: 99% with a scoped 100% is NOT exhausted — account verdict, not a per-bucket one", async () => {
  const home = tmpHome();
  try {
    const snap = await readClaudeUsage({
      env: { SWARM_HOME: home },
      now: () => NOW,
      usageOptIn: true,
      quotaCheck: async () => ({ ...structuredClone(HEADROOM), source: "endpoint" }),
    });
    equal(snap.exhausted, false);
    ok(snap.buckets.some((b) => b.kind === "weekly" && b.percent === 100), "the scoped bucket is reported, not dropped");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("readClaudeUsage: cache and live readings carry distinct provenance tokens, neither ollama's 'cached'", async () => {
  const home = tmpHome();
  try {
    const live = await readClaudeUsage({
      env: { SWARM_HOME: home },
      now: () => NOW,
      usageOptIn: true,
      quotaCheck: async () => ({ ...structuredClone(HEADROOM), source: "endpoint" }),
    });
    // Fresh cache on disk, `now` in the walk's NUMBER form, and a fetch that
    // must never fire: hook mode reads the file the CLI refills, nothing else.
    writeFileSync(join(home, "quota-cache.json"), JSON.stringify({ ts: NOW - 10_000, result: structuredClone(HEADROOM) }));
    const cached = await readClaudeUsage({
      env: { SWARM_HOME: home },
      now: NOW,
      usageOptIn: false,
      fetch: async () => { throw new Error("hook mode must never fetch"); },
    });
    equal(live.provenance, "live");
    equal(cached.provenance, "cache");
    equal(cached.exhausted, false, "the verdict survives the cache round-trip");
    ok(live.provenance !== "cached" && cached.provenance !== "cached",
      "ollama's stale-cookie token is a different state; claude must not reuse it");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("readClaudeUsage: an unreachable endpoint returns a marked snapshot, never a silently healthy one", async () => {
  const home = tmpHome();
  try {
    const snap = await readClaudeUsage({
      env: { SWARM_HOME: home },
      now: () => NOW,
      usageOptIn: true,
      quotaCheck: async () => null,
    });
    equal(snap.provenance, "none");
    equal(snap.exhausted, undefined, "a failed read is unknown — neither headroom nor exhaustion");
    ok(typeof snap.reason === "string" && snap.reason.length > 0, JSON.stringify(snap));
    ok(snap.buckets.some((b) => b.kind === "unavailable"), JSON.stringify(snap.buckets));
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

// checkQuota's "stale" reading carries `asOfMs` — the timestamp of the cache it
// served. Defaulting to the read clock would date a ten-minute-old reading as
// fresh, and every staleness display reads `asOf` verbatim.
test("readClaudeUsage: a stale live reading keeps checkQuota's asOfMs, not the read clock", async () => {
  const home = tmpHome();
  try {
    const asOfMs = NOW - 900_000;
    const snap = await readClaudeUsage({
      env: { SWARM_HOME: home },
      now: () => NOW,
      usageOptIn: true,
      quotaCheck: async () => ({ ...structuredClone(HEADROOM), source: "stale", asOfMs }),
    });
    equal(snap.provenance, "stale");
    equal(snap.asOf, new Date(asOfMs).toISOString());
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

// usage.mjs's own rule: an expired Claude cache is refilled by the CLI
// unprompted, so the hook's reading is marked but stays SILENT — a reason here
// would banner every prompt for a condition that fixes itself.
test("readClaudeUsage: a stale cache in hook mode is marked none but carries no reason", async () => {
  const home = tmpHome();
  try {
    writeFileSync(join(home, "quota-cache.json"), JSON.stringify({ ts: NOW - 400_000, result: structuredClone(HEADROOM) }));
    const snap = await readClaudeUsage({ env: { SWARM_HOME: home }, now: NOW, usageOptIn: false });
    equal(snap.provenance, "none");
    equal(snap.reason, undefined, "the TTL refills silently; a reason would banner the hook");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});