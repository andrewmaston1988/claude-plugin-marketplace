import { test } from "node:test";
import { deepEqual, equal, ok } from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  CODEX_ACCOUNT_USAGE_METHOD,
  CODEX_RATE_LIMITS_METHOD,
  CODEX_RATE_LIMITS_UPDATED_METHOD,
  createCodexUsageAdapter,
  normalizeCodexAccountUsage,
  normalizeCodexRateLimits,
  readCodexUsage,
  subscribeCodexRateLimitUpdates,
} from "../src/codex-usage.mjs";

const NOW = "2026-09-19T12:00:00.000Z";

function clientFor({ fail = false } = {}) {
  return {
    async initialize() {},
    async request(method) {
      if (fail) throw new Error("offline");
      if (method === CODEX_RATE_LIMITS_METHOD) return {
        rateLimitsByLimitId: {
          session: { primary: { usedPercent: 20, windowDurationMins: 300, resetsAt: 111 }, secondary: null },
        },
      };
      if (method === CODEX_ACCOUNT_USAGE_METHOD) return {
        summary: { inputTokens: 10, outputTokens: 2 },
        dailyUsageBuckets: [{ date: "2026-09-19", inputTokens: 10 }],
      };
      throw new Error(`unexpected method ${method}`);
    },
  };
}

test("Codex usage normalizers preserve limit ids, windows, credits, and nulls", () => {
  const snapshot = normalizeCodexRateLimits({
    rateLimitsByLimitId: {
      session: { credits: { remaining: 4 }, primary: { resetsAt: 10 }, secondary: null },
    },
  }, { asOf: NOW });
  equal(snapshot.provider, "codex");
  equal(snapshot.source, CODEX_RATE_LIMITS_METHOD);
  equal(snapshot.buckets[0].limitId, "session");
  deepEqual(snapshot.buckets[0].secondary, null);
  deepEqual(snapshot.buckets[0].credits, { remaining: 4 });

  const usage = normalizeCodexAccountUsage({ summary: { inputTokens: 1 }, dailyUsageBuckets: null }, { asOf: NOW });
  deepEqual(usage.buckets[0].summary, { inputTokens: 1 });
  equal(usage.buckets[0].dailyUsageBuckets, null);
});

test("Codex usage reads both app-server endpoints without creating a disk cache", async () => {
  const dir = mkdtempSync(join(tmpdir(), "swarm-codex-usage-"));
  try {
    const cachePath = join(dir, "codex-usage.json");
    const snapshot = await readCodexUsage({}, { client: clientFor(), cachePath, now: () => NOW });
    equal(snapshot.provenance, "live");
    equal(snapshot.buckets.length, 2);
    equal(existsSync(cachePath), false);
    equal(existsSync(cachePath + ".tmp"), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Codex usage reports unknown provenance when app-server is unavailable", async () => {
  const dir = mkdtempSync(join(tmpdir(), "swarm-codex-usage-"));
  try {
    const cachePath = join(dir, "codex-usage.json");
    const snapshot = await readCodexUsage({}, { client: clientFor({ fail: true }), cachePath, now: () => NOW });
    equal(snapshot.provenance, "none");
    equal(snapshot.buckets[0].kind, "unavailable");
    equal(snapshot.buckets[0].reason, "offline");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Codex usage returns explicit unknown provenance without a cache", async () => {
  const dir = mkdtempSync(join(tmpdir(), "swarm-codex-usage-"));
  try {
    const snapshot = await readCodexUsage({}, { client: clientFor({ fail: true }), cachePath: join(dir, "missing.json"), now: () => NOW });
    equal(snapshot.provenance, "none");
    equal(snapshot.buckets[0].kind, "unavailable");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Codex usage adapter delegates through the provider capability", async () => {
  const adapter = createCodexUsageAdapter({ client: clientFor() });
  const snapshot = await adapter.readUsage({ now: () => NOW });
  equal(snapshot.provider, "codex");
});

test("Codex rate-limit update notifications normalize inline payloads", async () => {
  let listener;
  const client = {
    subscribe(fn) { listener = fn; return () => { listener = undefined; }; },
  };
  const updates = [];
  const unsubscribe = subscribeCodexRateLimitUpdates(client, {
    now: () => NOW,
    onUpdate: (snapshot) => updates.push(snapshot),
  });
  listener({
    method: CODEX_RATE_LIMITS_UPDATED_METHOD,
    params: { rateLimitsByLimitId: { session: { primary: { usedPercent: 42 } } } },
  });
  await new Promise((resolve) => setImmediate(resolve));
  equal(updates.length, 1);
  equal(updates[0].source, CODEX_RATE_LIMITS_UPDATED_METHOD);
  equal(updates[0].buckets[0].primary.usedPercent, 42);
  unsubscribe();
  equal(listener, undefined);
});
