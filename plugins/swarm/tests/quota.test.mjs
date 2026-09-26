import { test } from "node:test";
import { equal, deepEqual, ok } from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  matchQuota, parseQuotaReset, parseUsageLimits, checkQuota, DEFAULT_QUOTA_PATTERNS,
} from "../src/quota.mjs";
import { runCliAsync } from "./helpers/cli.mjs";

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

// Item 3: Codex rides the same split as Ollama — `swarm usage` pays for the
// app-server process and caches the reading, `quota` renders what the cache
// holds. A spawn here would stall the command on a process it does not need.
// The spy is the proof: a node executable that only logs when it actually runs.

// A HOME whose config points Codex at the spy, so a genuine app-server spawn
// leaves the log file behind. No git fixture: `quota` reads config and cache,
// never a repo.
function codexSpawnSpy(dir) {
  const home = join(dir, "home");
  const log = join(dir, "codex-spawn.log");
  const spy = join(dir, "codex-spy.mjs");
  mkdirSync(home, { recursive: true });
  writeFileSync(spy, `import { appendFileSync } from "node:fs";\nappendFileSync(${JSON.stringify(log)}, "spawned\\n");\n`);
  writeFileSync(join(home, "config.json"), JSON.stringify({
    providers: {
      claude: { allowedRoots: [tmpdir()] },
      ollama: { enabled: true },
      codex: { enabled: true, path: process.execPath, appServerArgs: [spy] },
    },
  }));
  return { home, log };
}

const CODEX_CACHED = {
  provider: "codex",
  source: "codex-app-server",
  provenance: "live",
  asOf: "2026-09-26T10:00:00.000Z",
  buckets: [{ kind: "rate-limit", limitId: "session", primary: { usedPercent: 20, windowDurationMins: 300, resetsAt: 1790000000 } }],
};

test("quota: prints the cached Codex row and never spawns the app-server", async () => {
  const dir = mkdtempSync(join(tmpdir(), "swarm-quota-cli-"));
  try {
    const { home, log } = codexSpawnSpy(dir);
    writeFileSync(join(home, "codex-usage.json"), JSON.stringify(CODEX_CACHED));
    const r = await runCliAsync(["quota"], { cwd: dir, env: { SWARM_HOME: home, TZ: "Europe/London" } });
    equal(r.status, 0, r.stderr + r.stdout);
    ok(r.stdout.includes("codex session primary (5h) (session): 20%"), r.stdout);
    equal(existsSync(log), false, `quota must not spawn the Codex app-server:\n${r.stdout}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("quota: names the missing Codex reading rather than fetching one", async () => {
  const dir = mkdtempSync(join(tmpdir(), "swarm-quota-cli-"));
  try {
    const { home, log } = codexSpawnSpy(dir);
    const r = await runCliAsync(["quota"], { cwd: dir, env: { SWARM_HOME: home } });
    equal(r.status, 0, r.stderr + r.stdout);
    ok(r.stdout.includes("codex: no cached reading yet"), r.stdout);
    equal(existsSync(log), false, `quota must not spawn the Codex app-server:\n${r.stdout}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("quota: the same spy logs when the app-server IS spawned", async () => {
  const dir = mkdtempSync(join(tmpdir(), "swarm-quota-cli-"));
  try {
    const { home, log } = codexSpawnSpy(dir);
    // `usage` is the command whose job the Codex fetch is. Without this half,
    // "no log" above would hold just as well for a spy that never logs at all.
    await runCliAsync(["usage", "--provider", "codex"], { cwd: dir, env: { SWARM_HOME: home } });
    ok(existsSync(log), "the spy must log a genuine app-server spawn");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// A HOME pointing the Anthropic fetch at a local usage endpoint. `quota` reads
// config and cache only, so no git fixture.
function anthropicHome(dir, port) {
  const home = join(dir, "home");
  mkdirSync(home, { recursive: true });
  writeFileSync(join(home, "config.json"), JSON.stringify({
    providers: { claude: { enabled: true, allowedRoots: [tmpdir()] }, ollama: { enabled: true } },
    quotaUsageUrl: `http://127.0.0.1:${port}/usage`,
  }));
  return home;
}

test("quota: prints per-window utilization from the usage endpoint", async () => {
  const dir = mkdtempSync(join(tmpdir(), "swarm-quota-cli-"));
  const server = createServer((req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({
      limits: [
        { kind: "session", percent: 22, severity: "normal", resets_at: "2026-07-11T12:19:59Z" },
        { kind: "weekly_scoped", percent: 4, severity: "normal", resets_at: "2026-07-18T07:59:59Z", scope: { model: { display_name: "Fable" } } },
      ],
    }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const home = anthropicHome(dir, server.address().port);
    const creds = join(home, "creds.json");
    writeFileSync(creds, JSON.stringify({ claudeAiOauth: { accessToken: "tok" } }));
    const r = await runCliAsync(["quota"], { cwd: dir, env: { SWARM_HOME: home, SWARM_CREDENTIALS: creds, TZ: "Europe/London" } });
    equal(r.status, 0, r.stderr + r.stdout);
    ok(r.stdout.includes("session: 22%"), r.stdout);
    ok(r.stdout.includes("resets Sat 11 Jul, 13:19"), r.stdout);
    ok(r.stdout.includes("weekly_scoped (Fable): 4%"), r.stdout);
  } finally {
    server.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("quota: C0b every line is prefixed anthropic, not claude", async () => {
  const dir = mkdtempSync(join(tmpdir(), "swarm-quota-cli-"));
  const server = createServer((req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({
      limits: [
        { kind: "session", percent: 5, severity: "normal", resets_at: "2026-09-06T18:00:00Z" },
        { kind: "weekly_all", percent: 10, severity: "normal", resets_at: "2026-09-07T00:00:00Z" },
        { kind: "weekly_scoped", percent: 3, severity: "normal", resets_at: "2026-09-07T00:00:00Z", scope: { model: { display_name: "Fable" } } },
      ],
    }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const home = anthropicHome(dir, server.address().port);
    const creds = join(home, "creds.json");
    writeFileSync(creds, JSON.stringify({ claudeAiOauth: { accessToken: "tok" } }));
    const r = await runCliAsync(["quota"], { cwd: dir, env: { SWARM_HOME: home, SWARM_CREDENTIALS: creds } });
    equal(r.status, 0, r.stderr + r.stdout);
    const lines = r.stdout.trim().split("\n");
    equal(lines.length, 3, r.stdout);
    for (const l of lines) ok(l.startsWith("anthropic "), l);
    ok(!/\bclaude\b/i.test(r.stdout), r.stdout);
  } finally {
    server.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
