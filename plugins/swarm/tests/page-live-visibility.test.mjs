import { test } from "node:test";
import assert from "node:assert/strict";
import { listRow, listData, loadPage } from "./helpers/page-harness.mjs";

// A hidden tab must not hold an event stream: browsers cap connections per host
// across all tabs, so six idle streams starve every fetch.
const boot = async () => {
  const P = loadPage();
  await P.flush();
  P.respondList(listData(listRow()));
  await P.flush();
  P.fireEsOpen();
  await P.flush();
  return P;
};

test("V1: hidden closes the stream and leaves no reconnect timer", async () => {
  const P = await boot();
  const timers = P.armedTimeouts();
  P.fireVisibility("hidden");
  assert.equal(P.esClosedCount(), 1, "the open stream is closed");
  assert.equal(P.armedTimeouts(), timers, "hiding arms no timer");
});

test("V2: a CLOSED stream's pending backoff does not reopen while hidden", async () => {
  const P = await boot();
  const before = P.esCount();
  P.fireEsError(2 /* CLOSED */);
  assert.equal(P.armedTimeouts(), 1, "the backoff is pending");
  P.fireVisibility("hidden");
  assert.equal(P.armedTimeouts(), 0, "hiding clears the backoff");
  P.fireTimers(1000);
  await P.flush();
  assert.equal(P.esCount(), before, "no socket opens in a hidden tab");
});

test("V3: visible opens one new EventSource and its open triggers one route fetch", async () => {
  const P = await boot();
  const before = P.esCount();
  P.fireVisibility("hidden");
  P.fireVisibility("visible");
  assert.equal(P.esCount(), before + 1, "exactly one new stream");
  const lists = P.listFetches().length;
  P.fireEsOpen();
  await P.flush();
  assert.equal(P.listFetches().length, lists + 1, "the open runs one catch-up route");
});

test("V4: visible while already OPEN opens nothing new", async () => {
  const P = await boot();
  const before = P.esCount();
  P.fireVisibility("visible");
  assert.equal(P.esCount(), before, "no second stream");
  assert.equal(P.esClosedCount(), 0, "the live stream is untouched");
});

test("V5: visible while the stream is still CONNECTING opens nothing new", async () => {
  const P = loadPage();
  await P.flush();
  const before = P.esCount();
  P.fireVisibility("visible");
  assert.equal(P.esCount(), before, "a background-opened tab keeps its one connecting stream");
});

test("V6: a tab that boots hidden opens no stream until it is shown", async () => {
  const P = loadPage({ hidden: true });
  await P.flush();
  assert.equal(P.esCount(), 0, "a background-opened tab holds no socket");
  P.fireVisibility("visible");
  assert.equal(P.esCount(), 1, "showing it connects once");
});
