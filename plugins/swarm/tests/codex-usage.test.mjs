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

const LIMITS_OK = {
  rateLimitsByLimitId: {
    session: { primary: { usedPercent: 20, windowDurationMins: 300, resetsAt: 111 }, secondary: null },
  },
};

const ACCOUNT_OK = {
  summary: { inputTokens: 10, outputTokens: 2 },
  dailyUsageBuckets: [{ date: "2026-09-19", inputTokens: 10 }],
};

// `fail` rejects both endpoints; `failMethods` rejects only the named ones, so a
// half-failed read is expressible.
function clientFor({ fail = false, failMethods = [], limits = LIMITS_OK } = {}) {
  return {
    async initialize() {},
    async request(method) {
      if (fail) throw new Error("offline");
      if (failMethods.includes(method)) throw new Error(`refused: ${method}`);
      if (method === CODEX_RATE_LIMITS_METHOD) return limits;
      if (method === CODEX_ACCOUNT_USAGE_METHOD) return ACCOUNT_OK;
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

// Defect CS-2 — a rejected half was recorded and then discarded, and the one
// reading that lost data was exactly the one `provenanceBanner` suppresses for
// being `live`. The failure must reach the snapshot it belongs to.
test("Codex usage marks a half-failed read partial and names the endpoint that failed", async () => {
  const snapshot = await readCodexUsage({}, {
    client: clientFor({ failMethods: [CODEX_ACCOUNT_USAGE_METHOD] }),
    now: () => NOW,
  });

  equal(snapshot.provenance, "partial");
  ok(snapshot.reason?.includes(CODEX_ACCOUNT_USAGE_METHOD), `reason must name the failed endpoint: ${snapshot.reason}`);

  const unavailable = snapshot.buckets.filter((bucket) => bucket.kind === "unavailable");
  equal(unavailable.length, 1, "the failed half must ride as an unavailable bucket");
  ok(unavailable[0].reason.includes(CODEX_ACCOUNT_USAGE_METHOD), unavailable[0].reason);

  // The half that DID answer keeps its figures — a partial read is not a blank one.
  ok(snapshot.buckets.some((bucket) => bucket.kind === "rate-limit"));
});

// The negative half: a clean two-endpoint success gains no caveat and no bucket.
// Without this, a fix that marks everything partial reads as correct.
test("Codex usage reports a clean two-endpoint read as live with no reason", async () => {
  const snapshot = await readCodexUsage({}, { client: clientFor(), now: () => NOW });
  equal(snapshot.provenance, "live");
  equal(snapshot.reason, undefined);
  equal(snapshot.buckets.some((bucket) => bucket.kind === "unavailable"), false);
});

// Defect CS-3's field, asserted on the contract-validated return: `record()`
// strips any field that is not in the record's optional list, so a gate reading
// `exhausted` sees `undefined` however loudly the source sets it.
test("Codex usage reports exhaustion from the rate-limit half", async () => {
  const read = (limits) => readCodexUsage({}, { client: clientFor({ limits }), now: () => NOW });

  const full = await read({ rateLimitsByLimitId: { session: { primary: { usedPercent: 100 } } } });
  equal(full.exhausted, true);

  const nearly = await read({ rateLimitsByLimitId: { session: { primary: { usedPercent: 99 } } } });
  equal(nearly.exhausted, false);

  // The secondary window counts too — it is a rate-limit window like any other.
  const secondary = await read({ rateLimitsByLimitId: { session: { primary: { usedPercent: 9 }, secondary: { usedPercent: 100 } } } });
  equal(secondary.exhausted, true);

  // Account usage alone is a measurement, not a limit: a read that lost the
  // rate-limit half must not read as exhausted.
  const accountOnly = await readCodexUsage({}, {
    client: clientFor({ failMethods: [CODEX_RATE_LIMITS_METHOD] }),
    now: () => NOW,
  });
  equal(accountOnly.exhausted, false);
  equal(accountOnly.provenance, "partial");
});

// Defect CS-8 — the request path and the caller's own onUpdate shared one
// `.catch((error) => onError?.(error))`, and onError is optional. With none
// supplied every failure was a silent no-op: rate-limit live updates stopped
// arriving with no diagnostic anywhere. A failure may be unwitnessed, never
// unwitnessable.
async function withWarningSpy(fn) {
  const warnings = [];
  const onWarning = (warning) => warnings.push(warning);
  process.on("warning", onWarning);
  try {
    return await fn(warnings);
  } finally {
    process.off("warning", onWarning);
  }
}

// Two macrotask-free ticks: one for the request's rejection to settle, one for
// the .catch handler's own continuation.
const settle = () => new Promise((resolve) => setImmediate(resolve));

function failingSubscriptionClient() {
  const client = {
    subscribe(fn) { client.listener = fn; return () => { client.listener = undefined; }; },
    async request() { throw new Error("subscription offline"); },
  };
  return client;
}

test("Codex rate-limit subscription warns when a failure has no onError to go to", async () => {
  await withWarningSpy(async (warnings) => {
    const client = failingSubscriptionClient();
    subscribeCodexRateLimitUpdates(client, { now: () => NOW, onUpdate: () => {} });
    client.listener({ method: CODEX_RATE_LIMITS_UPDATED_METHOD });
    await settle();
    await settle();

    equal(warnings.length, 1, "a swallowed failure must surface somewhere");
    ok(warnings[0].message.includes("subscription offline"), warnings[0].message);
    ok(/rate.?limit/i.test(warnings[0].message), `the warning must name its subject: ${warnings[0].message}`);
  });
});

// The negative half: a caller that DID supply onError stays its sole receiver —
// without this, a fix that warns unconditionally reads as correct.
test("Codex rate-limit subscription gives a failure to onError and warns not at all", async () => {
  await withWarningSpy(async (warnings) => {
    const seen = [];
    const client = failingSubscriptionClient();
    subscribeCodexRateLimitUpdates(client, { now: () => NOW, onUpdate: () => {}, onError: (error) => seen.push(error) });
    client.listener({ method: CODEX_RATE_LIMITS_UPDATED_METHOD });
    await settle();
    await settle();

    equal(seen.length, 1);
    equal(seen[0].message, "subscription offline");
    equal(warnings.length, 0, `an onError caller must be the only receiver: ${warnings.map((w) => w.message).join(" | ")}`);
  });
});


