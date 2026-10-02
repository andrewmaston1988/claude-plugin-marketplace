import { test } from "node:test";
import assert from "node:assert/strict";
import { createBrokerClient } from "../../src/remote/broker-client.mjs";

test("wait: the retry after a connection error keeps the caller's abort signal", async () => {
  const signals = [];
  const _fetch = async (url, opts = {}) => {
    if (url.endsWith("/health")) return { ok: true, json: async () => ({ status: "ok" }) };
    signals.push(opts.signal);
    if (signals.length === 1) throw new TypeError("fetch failed");
    return { ok: true, json: async () => [] };
  };
  const client = createBrokerClient({ port: 1, _fetch });
  const signal = AbortSignal.timeout(60_000);
  await client.wait("p1", 55_000, { signal });
  assert.equal(signals.length, 2);
  assert.equal(signals[1], signal);
});
