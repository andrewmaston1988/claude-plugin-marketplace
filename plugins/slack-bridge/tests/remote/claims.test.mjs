// Claim store: maps a Slack channel → the live-session peer-id that seized it.
// Atomic JSON writes (session-store pattern); corrupt-recovery; collision rejection.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createClaimsStore } from "../../src/remote/claims.mjs";

function tmpFile() {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), "slack-claims-")), "claims.json");
}

test("claim records channel → peer; get returns it", async () => {
  const store = createClaimsStore({ path: tmpFile() });
  const r = await store.claim("peerA", "C1");
  assert.equal(r.ok, true);
  const claim = store.get("C1");
  assert.equal(claim.peer_id, "peerA");
  assert.equal(claim.channel, "C1");
  assert.ok(claim.claimed_at);
});

test("claim by a different peer while channel is claimed is rejected", async () => {
  const store = createClaimsStore({ path: tmpFile() });
  await store.claim("peerA", "C1");
  const r = await store.claim("peerB", "C1");
  assert.equal(r.ok, false);
  assert.match(r.error, /already claimed|claimed by/i);
  // original claim unchanged
  assert.equal(store.get("C1").peer_id, "peerA");
});

test("claim by the same peer again is idempotent", async () => {
  const store = createClaimsStore({ path: tmpFile() });
  await store.claim("peerA", "C1");
  const r = await store.claim("peerA", "C1");
  assert.equal(r.ok, true);
  assert.equal(store.get("C1").peer_id, "peerA");
});

test("release clears the claim for that peer", async () => {
  const store = createClaimsStore({ path: tmpFile() });
  await store.claim("peerA", "C1");
  await store.release("peerA");
  assert.equal(store.get("C1"), null);
});

test("reapDead drops claims whose peer is not alive; keeps live ones", async () => {
  const store = createClaimsStore({ path: tmpFile() });
  await store.claim("peerA", "C1");
  await store.claim("peerB", "C2");
  const alive = new Set(["peerA"]);
  const broker = { isAlive: async (id) => alive.has(id) };
  const reaped = await store.reapDead(broker);
  assert.deepEqual(reaped.sort(), ["peerB"]);
  assert.equal(store.get("C1").peer_id, "peerA");
  assert.equal(store.get("C2"), null);
});

test("state persists across a close + reload (atomic write)", async () => {
  const file = tmpFile();
  const a = createClaimsStore({ path: file });
  await a.claim("peerA", "C1");
  const b = createClaimsStore({ path: file });
  const claim = b.get("C1");
  assert.equal(claim.peer_id, "peerA");
});

test("all() returns a snapshot of every claim", async () => {
  const store = createClaimsStore({ path: tmpFile() });
  await store.claim("peerA", "C1");
  await store.claim("peerB", "C2");
  const all = store.all();
  assert.deepEqual(Object.keys(all).sort(), ["C1", "C2"]);
});