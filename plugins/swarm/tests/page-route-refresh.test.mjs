// A refresh that fails or hangs keeps the committed screen; a failed navigation
// still paints the error panel over its skeleton.
import { test } from "node:test";
import assert from "node:assert/strict";
import { RUN_URL, listRow, listData, loadPage } from "./helpers/page-harness.mjs";

test("Test 10: a hung list refresh keeps the screen and frees the next refresh", async () => {
  const P = loadPage();
  await P.flush();
  P.respondList(listData(listRow()));
  await P.flush();
  const beforeTimeout = P.screenText();
  P.fireSse("runs"); await P.flush();
  assert.equal(P.pendingCount(), 1, "the refresh is in flight");
  P.fireTimers(20000); await P.flush();
  assert.equal(P.screenText(), beforeTimeout, "a timed-out refresh keeps the last good screen");
  assert.equal(P.findByClass("empty").length, 0);
  const before = P.listFetches().length;
  P.fireSse("runs"); await P.flush();
  assert.equal(P.listFetches().length - before, 1, "the next event starts a new fetch");
});

test("a failed refresh keeps the committed screen without an error panel", async () => {
  const P = loadPage();
  await P.flush();
  P.respondList(listData(listRow()));
  await P.flush();
  const before = P.screenText();
  P.fireSse("runs");
  await P.flush();
  P.fail((url) => url.startsWith("/api/runs"));
  await P.flush();
  assert.equal(P.screenText(), before, "the last good screen remains unchanged");
  assert.equal(P.findByClass("empty").length, 0, "a failed refresh is silent");
});

test("a failed navigation paints the error panel over its skeleton", async () => {
  const P = loadPage();
  await P.flush();
  P.respondList(listData(listRow()));
  await P.flush();
  P.location.hash = RUN_URL;
  P.fireHashchange();
  await P.flush();
  P.fail((url) => url.startsWith("/api/runs/"));
  await P.flush();
  assert.equal(P.findByClass("empty").length, 1);
  assert.ok(P.screenText().includes("500 /api/runs"));
});
