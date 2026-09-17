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

// One claim per peer: replies are drained from_id-scoped, so a peer holding two
// channels would see the second route's replies surface in the first's Slack
// channel. The store rejects the second channel before any Slack channel is created.
test("a peer holding one channel cannot claim a second", async () => {
  const store = createClaimsStore({ path: tmpFile() });
  await store.claim("peerA", "C1", { channelName: "rc-one" });
  const r = await store.claim("peerA", "C2");
  assert.equal(r.ok, false);
  assert.match(r.error, /already holds/i);
  assert.equal(store.get("C1").peer_id, "peerA", "original claim must stay intact");
  assert.equal(store.get("C2"), null, "the rejected claim must not be recorded");
});

test("after release, the same peer can claim a different channel", async () => {
  const store = createClaimsStore({ path: tmpFile() });
  await store.claim("peerA", "C1");
  await store.release("peerA");
  const r = await store.claim("peerA", "C2");
  assert.equal(r.ok, true);
});

test("canClaim is the pure pre-check — same rules, no writes", async () => {
  const store = createClaimsStore({ path: tmpFile() });
  await store.claim("peerB", "C1", { channelName: "rc-one" });
  assert.equal(store.canClaim("peerB", "C2").ok, false, "second channel for the same peer");
  assert.equal(store.canClaim("peerC", "C1").ok, false, "channel held by another peer");
  assert.equal(store.canClaim("peerB", "C1").ok, true, "idempotent re-claim of held channel");
  assert.equal(store.canClaim("peerD", "C3").ok, true, "fresh claim");
  assert.equal(store.get("C2"), null, "canClaim must never write");
});

// The store loads a bare JSON.parse product, so a bare index returns inherited
// properties: `data["constructor"]` is Object (truthy), which the routing branch
// reads as a live claim and canClaim reads as "already claimed by undefined".

test("a prototype key is not a claim: get() returns null for constructor/toString", () => {
  const store = createClaimsStore({ path: tmpFile() });
  assert.equal(store.get("constructor"), null);
  assert.equal(store.get("toString"), null);
  assert.equal(store.get("__proto__"), null);
});

test("claiming a prototype-key channel is not falsely rejected as already claimed", () => {
  const store = createClaimsStore({ path: tmpFile() });
  const r = store.claim("peerA", "constructor");
  assert.equal(r.ok, true, `a prototype-key channel must be claimable, got: ${r.error}`);
  assert.equal(store.get("constructor").peer_id, "peerA");
});
