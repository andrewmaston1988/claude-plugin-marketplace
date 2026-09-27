// A caller holding a live Codex client has already paid for the app-server, so
// the TTL must never stand between it and the client's own answer — and that
// answer is banked like every other live read, so the next reader inherits it
// instead of spending a spawn of its own.
import { test } from "node:test";
import { equal, ok } from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createCodexProviderAdapter } from "../src/codex.mjs";
import { readUsageEnvelope, writeUsageReading } from "../src/usage-cache.mjs";

const T0 = 1_700_000_000_000;
const CONFIG = { providers: { codex: { enabled: true } } };

function clientFor(usedPercent) {
  return {
    async initialize() {},
    async request(method) {
      if (method === "account/rateLimits/read") return { rateLimitsByLimitId: { five_hour: { primary: { usedPercent } } } };
      if (method === "account/usage/read") return { summary: { inputTokens: 1 } };
      throw new Error(`unexpected ${method}`);
    },
  };
}

function tmpDir() {
  return mkdtempSync(join(tmpdir(), "swarm-codex-bank-"));
}

test("B1 a live-client read is banked, so the next reader inherits it", async () => {
  const dir = tmpDir();
  try {
    const cachePath = join(dir, "codex-usage.json");
    const reading = await createCodexProviderAdapter().capabilities.readUsage({
      config: CONFIG, client: clientFor(12), cachePath, now: () => T0,
    });
    equal(reading.provenance, "live");
    const banked = readUsageEnvelope("codex", { cachePath });
    ok(banked, "RED: a live read the caller already paid for must be banked");
    equal(banked.fetchedAt, T0);
    equal(banked.result.provider, "codex");
    equal(banked.result.buckets.length, 2, "the banked reading is the whole snapshot");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("B2 a live client answers past a fresh TTL file, and that answer replaces it", async () => {
  const dir = tmpDir();
  try {
    const cachePath = join(dir, "codex-usage.json");
    writeUsageReading("codex", { fetchedAt: T0 - 60_000, result: { provider: "codex", buckets: [], tag: "banked" } }, { cachePath });
    const reading = await createCodexProviderAdapter().capabilities.readUsage({
      config: CONFIG, client: clientFor(12), cachePath, now: () => T0,
    });
    equal(reading.tag, undefined, "RED: a minute-old reading must not answer a live client");
    equal(reading.provenance, "live");
    const banked = readUsageEnvelope("codex", { cachePath });
    equal(banked.result.tag, undefined, "RED: the live answer must replace the banked one");
    equal(banked.fetchedAt, T0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
