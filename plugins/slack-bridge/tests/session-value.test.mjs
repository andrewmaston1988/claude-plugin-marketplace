import { test } from "node:test";
import assert from "node:assert/strict";
import { readSession, channelModel, writeSession, clearSession, setChannelModel, isSessionValue } from "../src/core/session-value.mjs";
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

test("setChannelModel — a legacy session of unknown backend is dropped when a model is first set", () => {
  const store = makeStore({ C1: "sess-legacy", "C1:111.1": "thread-legacy" });
  setChannelModel(store, "C1", "gpt-x");
  assert.deepEqual(store._data.C1, { model: "gpt-x" });
  assert.equal("C1:111.1" in store._data, false);
});

test("isSessionValue — accepts a legacy string or an object of string fields, nothing else", () => {
  assert.equal(isSessionValue("sess"), true);
  assert.equal(isSessionValue({ sessionId: "s", model: "sonnet" }), true);
  assert.equal(isSessionValue({ model: "sonnet" }), true);
  assert.equal(isSessionValue({ sessionId: 7 }), false);
  assert.equal(isSessionValue(null), false);
  assert.equal(isSessionValue(["s"]), false);
  assert.equal(isSessionValue(3), false);
});
