import { test } from "node:test";
import assert from "node:assert/strict";
import { readSession, channelModel, writeSession, clearSession } from "../src/core/session-value.mjs";
import { makeStore } from "./fakes.mjs";

test("readSession — a legacy bare string reads as a session with no model", () => {
  const store = makeStore({ C1: "sess-legacy" });
  assert.deepEqual(readSession(store, "C1"), { sessionId: "sess-legacy" });
  assert.equal(channelModel(store, "C1"), null);
});

test("readSession — an object value passes through; a missing key is empty", () => {
  const store = makeStore({ C1: { sessionId: "s", model: "sonnet" } });
  assert.deepEqual(readSession(store, "C1"), { sessionId: "s", model: "sonnet" });
  assert.deepEqual(readSession(store, "C2"), {});
  assert.equal(channelModel(store, "C1"), "sonnet");
});

test("writeSession — merges into the existing value, upgrading a legacy string", () => {
  const store = makeStore({ C1: "old", C2: { model: "sonnet" } });
  writeSession(store, "C1", { sessionId: "new" });
  writeSession(store, "C2", { sessionId: "s2" });
  assert.deepEqual(store._data.C1, { sessionId: "new" });
  assert.deepEqual(store._data.C2, { model: "sonnet", sessionId: "s2" });
});

test("clearSession — drops sessionId, keeps the model, deletes an emptied key", () => {
  const store = makeStore({ C1: { sessionId: "s", model: "sonnet" }, C2: "legacy" });
  clearSession(store, "C1");
  clearSession(store, "C2");
  assert.deepEqual(store._data.C1, { model: "sonnet" });
  assert.equal("C2" in store._data, false);
});
