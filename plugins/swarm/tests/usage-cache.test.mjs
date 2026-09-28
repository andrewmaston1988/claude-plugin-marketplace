// The one caching rule every provider's usage reading obeys: read the cache
// under 5 minutes, read live past it, serve the last reading marked stale when
// that live read fails. The clock and the fetch are injected; nothing here
// touches the network or the real SWARM_HOME.
import { test } from "node:test";
import { equal, deepEqual, notEqual, ok } from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, writeFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  USAGE_TTL_MS, usageReading, cachedUsageReading, readUsageEnvelope,
  writeUsageReading, patchUsageEnvelope, recordUsageError, usageTmpPath,
} from "../src/usage-cache.mjs";

const T0 = 1_700_000_000_000;
const AGE = (ms) => T0 - ms;

function tmpDir() {
  return mkdtempSync(join(tmpdir(), "swarm-usage-cache-"));
}

const snapshot = (tag) => ({ provider: "codex", buckets: [], tag });

test("U1 a reading under 5 minutes old is served from cache and fetchLive is not called", async () => {
  const dir = tmpDir();
  try {
    const path = join(dir, "codex-usage.json");
    writeUsageReading("codex", { fetchedAt: AGE(60_000), result: snapshot("banked") }, { cachePath: path });
    let calls = 0;
    const r = await usageReading("codex", {
      cachePath: path, now: () => T0,
      fetchLive: async () => { calls++; return snapshot("live"); },
    });
    equal(calls, 0, "RED: a 1-minute-old reading must not cost a live read");
    equal(r.provenance, "cached");
    equal(r.tag, "banked");
    equal(r.fetchedAt, AGE(60_000), "the reading keeps the moment it was read");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("U2 a reading 5 minutes or older forces fetchLive, and banks it with a fresh fetchedAt", async () => {
  const dir = tmpDir();
  try {
    const path = join(dir, "codex-usage.json");
    writeUsageReading("codex", { fetchedAt: AGE(USAGE_TTL_MS), result: snapshot("banked") }, { cachePath: path });
    let calls = 0;
    const r = await usageReading("codex", {
      cachePath: path, now: () => T0,
      fetchLive: async () => { calls++; return snapshot("live"); },
    });
    equal(calls, 1, "RED: a reading at the TTL boundary must not be served from cache");
    equal(r.provenance, "live");
    equal(r.tag, "live");
    equal(r.fetchedAt, T0);
    const banked = readUsageEnvelope("codex", { cachePath: path });
    equal(banked.fetchedAt, T0, "the next reader inherits the fresh stamp");
    equal(banked.result.tag, "live");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("U3 an expired reading whose live read fails is stale, keeps its fetchedAt, and the file is untouched", async () => {
  const dir = tmpDir();
  try {
    const path = join(dir, "codex-usage.json");
    writeUsageReading("codex", { fetchedAt: AGE(3 * USAGE_TTL_MS), result: snapshot("banked") }, { cachePath: path });
    const before = readFileSync(path, "utf8");
    const r = await usageReading("codex", {
      cachePath: path, now: () => T0,
      fetchLive: async () => { throw new Error("meter unreachable"); },
    });
    equal(r.provenance, "stale", "RED: a failed live read must not lose the reading");
    equal(r.tag, "banked");
    equal(r.fetchedAt, AGE(3 * USAGE_TTL_MS), "the original read time is what makes stale honest");
    equal(readFileSync(path, "utf8"), before, "expiry never deletes or rewrites the reading");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("U4 no cache and a failed live read returns no reading, never a throw", async () => {
  const dir = tmpDir();
  try {
    const path = join(dir, "codex-usage.json");
    equal(await usageReading("codex", { cachePath: path, now: () => T0, fetchLive: async () => null }), null);
    equal(await usageReading("codex", { cachePath: path, now: () => T0, fetchLive: async () => { throw new Error("down"); } }), null);
    equal(await usageReading("codex", { cachePath: path, now: () => T0 }), null, "cache-only with nothing cached is nothing");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("U5 the write is tmp+rename: no .tmp is left behind, and a reader never sees a half file", async () => {
  const dir = tmpDir();
  try {
    const path = join(dir, "codex-usage.json");
    writeUsageReading("codex", { fetchedAt: T0, result: snapshot("one") }, { cachePath: path });
    patchUsageEnvelope("codex", { lastError: "network-error", lastErrorAt: T0 }, { cachePath: path });
    deepEqual(readdirSync(dir).filter((f) => f.endsWith(".tmp")), [], "RED: a tmp file was abandoned beside the cache");
    deepEqual(JSON.parse(readFileSync(path, "utf8")).result.tag, "one");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("U6 two writers with different pids never share a tmp name", async () => {
  const path = join("home", "quota-cache.json");
  notEqual(usageTmpPath(path, 111), usageTmpPath(path, 222), "RED: the tmp name is shared, so two writers clobber each other");
  ok(usageTmpPath(path, 111).endsWith(".tmp"));
  ok(usageTmpPath(path, 111).startsWith(path), "the tmp sits beside its target, so the rename is same-volume");

  // Both writers land, one after the other, and the survivor is a whole file.
  const dir = tmpDir();
  try {
    const target = join(dir, "codex-usage.json");
    await Promise.all([
      usageReading("codex", { cachePath: target, now: () => T0, pid: 111, fetchLive: async () => snapshot("a") }),
      usageReading("codex", { cachePath: target, now: () => T0, pid: 222, fetchLive: async () => snapshot("b") }),
    ]);
    const written = readUsageEnvelope("codex", { cachePath: target });
    ok(["a", "b"].includes(written.result.tag), `one complete reading wins (got ${written.result.tag})`);
    deepEqual(readdirSync(dir).filter((f) => f.endsWith(".tmp")), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("U7 a cache-only caller never fetches, and gets the expired reading marked stale", async () => {
  const dir = tmpDir();
  try {
    const path = join(dir, "codex-usage.json");
    writeUsageReading("codex", { fetchedAt: AGE(USAGE_TTL_MS + 1), result: snapshot("banked") }, { cachePath: path });
    const r = await usageReading("codex", { cachePath: path, now: () => T0 });
    equal(r.provenance, "stale", "RED: a cache-only caller past the TTL must be marked stale");
    equal(r.tag, "banked");
    equal(r.fetchedAt, AGE(USAGE_TTL_MS + 1));

    const fresh = tmpDir();
    try {
      const freshPath = join(fresh, "codex-usage.json");
      writeUsageReading("codex", { fetchedAt: AGE(1000), result: snapshot("banked") }, { cachePath: freshPath });
      equal(cachedUsageReading("codex", { cachePath: freshPath, now: () => T0 }).provenance, "cached");
      equal(cachedUsageReading("codex", { cachePath: path, now: () => T0 }).provenance, "stale");
    } finally {
      rmSync(fresh, { recursive: true, force: true });
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("U8 a live write keeps retryAfter and lastError already in the file", async () => {
  const dir = tmpDir();
  try {
    const path = join(dir, "quota-cache.json");
    writeUsageReading("claude", { fetchedAt: AGE(2 * USAGE_TTL_MS), result: { limits: [{ kind: "session", percent: 5 }] } }, { cachePath: path });
    patchUsageEnvelope("claude", { retryAfter: T0 + 60_000, lastError: "network-error", lastErrorAt: AGE(120_000) }, { cachePath: path });
    const r = await usageReading("claude", {
      cachePath: path, now: () => T0,
      fetchLive: async () => ({ limits: [{ kind: "session", percent: 1 }] }),
    });
    equal(r.provenance, "live");
    const banked = readUsageEnvelope("claude", { cachePath: path });
    equal(banked.retryAfter, T0 + 60_000, "RED: the endpoint's own hold must survive a later successful read");
    equal(banked.lastError, "network-error");
    equal(banked.lastErrorAt, AGE(120_000));
    equal(banked.fetchedAt, T0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("U10 an unwritable cache is best-effort: the reading that succeeded is still returned", async () => {
  const dir = tmpDir();
  try {
    // A file where the directory should be, so every fs call in the write path
    // fails — the same shape as a read-only home, EPERM on rename, or ENOSPC.
    const blocker = join(dir, "not-a-dir");
    writeFileSync(blocker, "not a directory");
    const path = join(blocker, "codex-usage.json");

    const r = await usageReading("codex", {
      cachePath: path, now: () => T0,
      fetchLive: async () => snapshot("live"),
    });
    equal(r?.provenance, "live", "RED: a cache that cannot be written must not cost the reading that succeeded");
    equal(r.tag, "live");
    equal(r.fetchedAt, T0);

    const wrote = writeUsageReading("codex", { fetchedAt: T0, result: snapshot("x") }, { cachePath: path });
    equal(wrote.result.tag, "x", "a write returns what it was given whether or not it landed");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("U9 recordUsageError writes beside the reading, never re-stamps it, and skips a cache that is absent or corrupt", () => {
  const dir = tmpDir();
  try {
    const path = join(dir, "ollama-usage.json");
    recordUsageError("ollama", "expired-cookie", { at: T0, cachePath: path });
    ok(!readdirSync(dir).length, "no reading, no note");

    writeUsageReading("ollama", { fetchedAt: AGE(60_000), result: { weeklyPctUsed: 40 } }, { cachePath: path });
    recordUsageError("ollama", "expired-cookie", { at: T0, cachePath: path });
    const banked = readUsageEnvelope("ollama", { cachePath: path });
    equal(banked.result.weeklyPctUsed, 40, "the reading is untouched");
    equal(banked.fetchedAt, AGE(60_000), "and never re-stamped");
    equal(banked.lastError, "expired-cookie");
    equal(banked.lastErrorAt, T0);

    writeFileSync(path, "{not json");
    recordUsageError("ollama", "network-error", { at: T0, cachePath: path });
    equal(readFileSync(path, "utf8"), "{not json", "a corrupt cache is never overwritten");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
