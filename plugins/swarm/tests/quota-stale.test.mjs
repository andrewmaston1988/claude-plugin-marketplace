// A refused usage fetch (429) must not blank the reading: the last good one is served,
// and the endpoint's Retry-After is honoured so the dashboard stops extending the 429.
import { test } from "node:test";
import { equal, ok, rejects } from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { checkQuota, parseUsageLimits } from "../src/quota.mjs";

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

test("the Claude adapter carries a stale reading's failure reason onto its snapshot", async () => {
  const { readClaudeUsage } = await import("../src/claude-usage.mjs");
  const snap = await readClaudeUsage({ usageOptIn: true, now: T0 + 60 * 60_000,
    quotaCheck: async () => ({ limits: [{ kind: "session", percent: 40 }], source: "stale", asOfMs: T0, reason: "HTTP 429" }) });
  equal(snap.reason, "HTTP 429", "RED: the cause must reach the banner");
});

test("a failed read records why beside the reading it kept", async () => {
  const s = setup();
  try {
    await checkQuota(s.opts(T0));
    s.setReply({ ok: false, status: 503, headers: { get: () => null } });
    const q = await checkQuota(s.opts(T0 + 10 * 60_000));
    equal(q.reason, "HTTP 503", "RED: the reading served after a failed read names why");
    const env = JSON.parse(readFileSync(join(s.home, "q.json"), "utf8"));
    equal(env.lastError, "HTTP 503", "the refusal is recorded");
    equal(env.lastErrorAt, T0 + 10 * 60_000);
    equal(env.fetchedAt, T0, "the reading keeps the moment it was really read");
    s.setReply(tooMany(3600));
    await checkQuota(s.opts(T0 + 20 * 60_000));
    equal(JSON.parse(readFileSync(join(s.home, "q.json"), "utf8")).lastError, "HTTP 429", "a rate limit says so");
  } finally { rmSync(s.home, { recursive: true, force: true }); }
});

// ── the 429 hold reaches the model ───────────────────────────────────────
// A stale reading that is stale BECAUSE the endpoint refused must say so, with
// the hold's end, or the reader goes looking for a fix that cannot work yet.
const NOW = Date.parse("2026-10-01T12:00:00Z");
const READ_AT = NOW - 30 * 60_000;
const HOLD_UNTIL = NOW + 60 * 60_000;
const RESET = "2026-10-02T00:00:00Z";
const EXHAUSTED_100 = [{ kind: "session", percent: 100, severity: "exceeded", resets_at: RESET, scope: null }];
const SCOPED_100 = [
  { kind: "session", percent: 40, severity: null, resets_at: RESET, scope: null },
  { kind: "weekly", percent: 100, severity: "exceeded", resets_at: RESET, scope: { model: { display_name: "Sonnet" } } },
];

// The envelope as the cache banks it: `result` is parseUsageLimits' output, which
// is why the fixture goes through it rather than hand-writing `exhausted`.
function heldHome(limits, over = {}) {
  const home = mkdtempSync(join(tmpdir(), "swarm-quota-hold-"));
  writeFileSync(join(home, "creds.json"), JSON.stringify({ claudeAiOauth: { accessToken: "tok" } }));
  writeFileSync(join(home, "quota-cache.json"), JSON.stringify({
    fetchedAt: READ_AT, retryAfter: HOLD_UNTIL, lastError: "HTTP 429", lastErrorAt: READ_AT + 1000,
    result: parseUsageLimits({ limits }), ...over,
  }));
  return home;
}

const claudePreflight = async () => {
  const { defaultProviderAdapters } = await import("../src/providers.mjs");
  return defaultProviderAdapters().find((a) => a.id === "claude").capabilities.preflight;
};

test("the 429 hold rides from the cache onto the stale reading", async () => {
  const s = setup();
  try {
    await checkQuota(s.opts(T0));
    s.setReply(tooMany(3600));
    const q = await checkQuota(s.opts(T0 + 30 * 60_000));
    equal(q.source, "stale");
    equal(q.retryAfter, T0 + 30 * 60_000 + 3600_000, "RED: the hold must survive flatten");
    equal(q.reason, "HTTP 429");
  } finally { rmSync(s.home, { recursive: true, force: true }); }
});

test("holdNote names the refusal, the hold's end and that there is nothing to fix", async () => {
  const { holdNote } = await import("../src/usage.mjs");
  const held = { provenance: "stale", reason: "HTTP 429", retryAfter: HOLD_UNTIL, fetchedAt: READ_AT };
  const note = holdNote(held, { now: NOW, timeZone: "UTC" });
  ok(note.includes("HTTP 429"), note);
  ok(note.includes("Thu 1 Oct, 13:00"), `the hold's end is a literal instant: ${note}`);
  ok(note.includes("nothing to fix"), note);
  equal(holdNote({ ...held, provenance: "live" }, { now: NOW }), "", "only a stale reading is held");
  equal(holdNote({ ...held, retryAfter: NOW - 1 }, { now: NOW }), "", "an elapsed hold is not a hold");
  equal(holdNote({ provenance: "stale", reason: "HTTP 429" }, { now: NOW }), "", "no banked hold, no claim about one");
});

test("the stale banner reports the hold in place of the refresh line", async () => {
  const { provenanceBanner } = await import("../src/usage.mjs");
  const held = { provider: "anthropic", provenance: "stale", reason: "HTTP 429", retryAfter: HOLD_UNTIL, fetchedAt: READ_AT };
  const lines = provenanceBanner(held, { now: NOW });
  ok(lines.some((l) => l.includes("HTTP 429") && l.includes("nothing to fix")), lines.join("\n"));
  ok(!lines.some((l) => l.includes("Refresh:")), `a refresh cannot work under the hold: ${lines.join("\n")}`);
  const after = provenanceBanner(held, { now: HOLD_UNTIL + 1000 });
  ok(after.some((l) => l.includes("Refresh:")), `the hold has passed, so the fix is named again: ${after.join("\n")}`);
});

// `serve doctor` probes with no io; a warn-band reading must not throw on it.
test("preflight: an io-less probe survives a warn-band reading", async () => {
  const home = heldHome([{ kind: "session", percent: 90, severity: null, resets_at: RESET, scope: null }]);
  try {
    const preflight = await claudePreflight();
    const res = await preflight({
      config: {}, env: { SWARM_HOME: home, SWARM_CREDENTIALS: join(home, "creds.json") },
      now: () => NOW, fetch: async () => { throw new Error("a held reading must not be re-asked"); },
    });
    equal(res.ok, true);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test("preflight: a stale account-wide exhaustion warns instead of refusing", async () => {
  const home = heldHome(EXHAUSTED_100);
  try {
    const lines = [];
    let fetches = 0;
    const preflight = await claudePreflight();
    const res = await preflight({
      config: {}, env: { SWARM_HOME: home, SWARM_CREDENTIALS: join(home, "creds.json") },
      now: () => NOW, io: { stdout: (l) => lines.push(l) },
      fetch: async () => { fetches++; throw new Error("a held reading must not be re-asked"); },
      tasks: [{ id: "a", model: "claude-opus-5" }],
    });
    equal(res.ok, true, "a stale reading warns, it never grounds a leaf");
    equal(fetches, 0, "the hold is armed, so nothing is asked");
    ok(lines.some((l) => l.includes("stale · read") && l.includes("HTTP 429")), lines.join("\n"));
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test("preflight: a stale scoped exhaustion warns for the model it names", async () => {
  const home = heldHome(SCOPED_100);
  try {
    const lines = [];
    const preflight = await claudePreflight();
    const res = await preflight({
      config: {}, env: { SWARM_HOME: home, SWARM_CREDENTIALS: join(home, "creds.json") },
      now: () => NOW, io: { stdout: (l) => lines.push(l) },
      fetch: async () => { throw new Error("a held reading must not be re-asked"); },
      tasks: [{ id: "s", model: "claude-sonnet-5" }],
    });
    equal(res.ok, true);
    ok(lines.some((l) => l.includes("Sonnet-scoped") && l.includes("stale · read")), lines.join("\n"));
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test("preflight: the same 100% reading inside the TTL still refuses", async () => {
  const home = heldHome(EXHAUSTED_100, { fetchedAt: NOW - 60_000, retryAfter: undefined, lastError: undefined, lastErrorAt: undefined });
  try {
    const preflight = await claudePreflight();
    await rejects(() => preflight({
      config: {}, env: { SWARM_HOME: home }, now: () => NOW, io: { stdout: () => {} },
      fetch: async () => { throw new Error("a fresh reading is not re-fetched"); },
      tasks: [{ id: "a", model: "claude-opus-5" }],
    }), /Anthropic usage exhausted/);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test("preflight: a fresh Sonnet-scoped 100% reading still refuses that model", async () => {
  const home = heldHome(SCOPED_100, { fetchedAt: NOW - 60_000, retryAfter: undefined, lastError: undefined, lastErrorAt: undefined });
  try {
    const preflight = await claudePreflight();
    await rejects(() => preflight({
      config: {}, env: { SWARM_HOME: home }, now: () => NOW, io: { stdout: () => {} },
      fetch: async () => { throw new Error("a fresh reading is not re-fetched"); },
      tasks: [{ id: "s", model: "claude-sonnet-5" }],
    }), /Anthropic usage exhausted/);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

// ── the gate, `quota` and `usage` ────────────────────────────────────────
const GATE_CFG = {
  providers: { claude: { enabled: true } }, concurrency: 4, timeoutMs: 600000,
  resultInlineCap: 4000, worktreeBranchPrefix: "swarm/",
};
const staleClaudeAdapter = (provenance) => ({
  id: "claude", runnerId: "claude", enabled: () => true, validateTask: () => [],
  capabilities: {
    readUsage: async () => ({
      provider: "claude", buckets: [{ kind: "session", percent: 100, resetsAt: RESET }],
      source: "anthropic-oauth-usage", provenance, exhausted: true, reason: "HTTP 429",
      asOf: new Date(READ_AT).toISOString(), retryAfter: Date.now() + 3600_000,
    }),
  },
});

async function runGate(dir, provenance) {
  const { runPlan } = await import("../src/scheduler.mjs");
  const { createProviderRegistry } = await import("../src/providers.mjs");
  const { fakeSpawnFactory, makeIo } = await import("./helpers/fake-io.mjs");
  const spawn = fakeSpawnFactory(() => ({ output: "ok" }));
  const io = makeIo(spawn);
  const providerRegistry = createProviderRegistry([staleClaudeAdapter(provenance)]);
  const task = {
    id: "c", prompt: "do c", provider: "claude", model: "claude-sonnet-5", allowedTools: "Read",
    cwd: dir, originalCwd: dir, timeoutMs: 5000, after: [],
  };
  const plan = { cwd: dir, resultsDir: join(dir, "run"), concurrency: 1, goal: "", tasks: [task] };
  return runPlan(plan, { ...GATE_CFG, allowedRoots: [dir] }, io, { providerRegistry, providerUsage: true })
    .then(() => ({ io, ok: true }), (error) => ({ io, ok: false, error }));
}

test("the scheduler gate warns, never refuses, on a stale provider reading", async () => {
  const dir = mkdtempSync(join(tmpdir(), "swarm-gate-stale-"));
  try {
    const r = await runGate(dir, "stale");
    equal(r.ok, true, r.error?.message);
    ok(r.io.lines.some((l) => l.includes("stale") && l.includes("nothing to fix")), r.io.lines.join("\n"));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("the scheduler gate still refuses a live exhausted reading", async () => {
  const dir = mkdtempSync(join(tmpdir(), "swarm-gate-live-"));
  try {
    const r = await runGate(dir, "live");
    equal(r.ok, false);
    ok(/usage is exhausted/.test(r.error.message), r.error.message);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("swarm quota: a held 100% reading marks itself stale, says nothing to fix, and exits 0", async () => {
  const { printQuota } = await import("../src/quota.mjs");
  const home = mkdtempSync(join(tmpdir(), "swarm-quota-cmd-"));
  try {
    const nowMs = Date.now();
    writeFileSync(join(home, "q.json"), JSON.stringify({
      fetchedAt: nowMs - 30 * 60_000, retryAfter: nowMs + 60 * 60_000,
      lastError: "HTTP 429", lastErrorAt: nowMs - 30 * 60_000 + 1000,
      result: parseUsageLimits({ limits: [{ kind: "weekly_all", percent: 100, severity: "exceeded", resets_at: new Date(nowMs + 86400_000).toISOString(), scope: null }] }),
    }));
    const lines = [];
    const code = await printQuota({
      cfg: {}, out: (l) => lines.push(l), cachePath: join(home, "q.json"),
      fetchImpl: async () => { throw new Error("a held reading must not be re-asked"); },
    });
    ok(lines.some((l) => l.includes("stale · read") && l.includes("100%")), lines.join("\n"));
    ok(lines.some((l) => l.includes("HTTP 429") && l.includes("nothing to fix")), lines.join("\n"));
    ok(!lines.some((l) => l.includes("[exceeded]")), `a stale severity contradicts the warning: ${lines.join("\n")}`);
    ok(!lines.some((l) => l.includes("weekly allowance exhausted")), `a stale verdict contradicts the warning: ${lines.join("\n")}`);
    equal(code, 0, "a stale exhaustion is not an exit-1 verdict");
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test("swarm usage: a stale exhausted Anthropic reading exits 0, a live one exits 1", async () => {
  const { cmdUsage } = await import("../scripts/swarm.mjs");
  const stale = { limits: [{ kind: "session", percent: 100, resetsAt: RESET, scope: null }], exhausted: true, source: "stale", asOfMs: READ_AT, reason: "HTTP 429" };
  const live = { ...stale, source: "endpoint", asOfMs: NOW };
  equal(await cmdUsage([], { cfg: {}, env: process.env, quotaCheck: async () => stale, write: () => {} }), 0);
  equal(await cmdUsage([], { cfg: {}, env: process.env, quotaCheck: async () => live, write: () => {} }), 1);
});
