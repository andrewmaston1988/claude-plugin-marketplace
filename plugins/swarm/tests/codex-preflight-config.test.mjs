import { test } from "node:test";
import { equal, match } from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCodexProviderAdapter } from "../src/codex.mjs";

const limits = (usedPercent) => ({ rateLimitsByLimitId: { five_hour: { primary: { usedPercent } } } });
const clientFor = (reading) => ({
  async initialize() {},
  async request(method) {
    if (reading instanceof Error) throw reading;
    if (method === "account/rateLimits/read") {
      return reading;
    }
    if (method === "account/usage/read") return { summary: { inputTokens: 1 } };
    throw new Error(`unexpected ${method}`);
  },
});

function preflightContext(t) {
  const home = mkdtempSync(join(tmpdir(), "swarm-codex-preflight-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  return {
    config: { providers: { codex: { enabled: true } } },
    cachePath: join(home, "codex-usage.json"),
  };
}

test("quotaPreflight false skips Codex usage preflight without spawning", async () => {
  let spawned = false;
  const adapter = createCodexProviderAdapter({ spawnImpl() { spawned = true; throw new Error("must not spawn"); } });
  const result = await adapter.capabilities.preflight({
    config: { quotaPreflight: false, providers: { codex: { enabled: true } } },
  });
  equal(result.ok, true);
  equal(spawned, false);
});

test("stale exhausted Codex usage warns and dispatches", async (t) => {
  const adapter = createCodexProviderAdapter();
  const context = preflightContext(t);
  const now = 1_000_000;
  await adapter.capabilities.preflight({ ...context, now, client: clientFor(limits(100)) });

  const lines = [];
  const result = await adapter.capabilities.preflight({
    ...context,
    now: now + 6 * 60_000, // past the Codex cache's 5-minute USAGE_TTL_MS
    tasks: [{ id: "stale" }],
    io: { stdout: (line) => lines.push(line) },
    client: clientFor(new Error("app-server unavailable")),
  });
  equal(result.ok, true);
  equal(result.usage.provenance, "stale");
  equal(lines.length, 1);
  match(lines[0], /Codex usage reads exhausted on a stale reading .* dispatching anyway/);
  match(lines[0], /stale · read 6m ago/);
});

test("live exhausted Codex usage still refuses undefended tasks", async (t) => {
  const adapter = createCodexProviderAdapter();
  const result = await adapter.capabilities.preflight({
    ...preflightContext(t),
    tasks: [{ id: "live" }],
    client: clientFor(limits(100)),
  });
  equal(result.ok, false);
  match(result.error, /live/);
});

test("io-less stale exhausted Codex usage dispatches", async (t) => {
  const adapter = createCodexProviderAdapter();
  const context = preflightContext(t);
  const now = 2_000_000;
  await adapter.capabilities.preflight({ ...context, now, client: clientFor(limits(100)) });
  const result = await adapter.capabilities.preflight({
    ...context,
    now: now + 6 * 60_000, // past the Codex cache's 5-minute USAGE_TTL_MS
    tasks: [{ id: "stale" }],
    client: clientFor(new Error("app-server unavailable")),
  });
  equal(result.ok, true);
  equal(result.usage.provenance, "stale");
});
