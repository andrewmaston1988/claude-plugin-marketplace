import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createSessionStore } from "../src/session-store/index.mjs";

function makeLog() {
  const warns = [];
  return { info: () => {}, warn: (...a) => warns.push(a), error: () => {}, warns };
}

function tmpStore() {
  const dir = join(tmpdir(), `claude-slack-ss-${process.pid}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, "sessions.json");
  return { path, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test("session-store — get returns undefined on missing key", () => {
  const { path, cleanup } = tmpStore();
  try {
    const store = createSessionStore({ path, log: makeLog() });
    assert.strictEqual(store.get("C123"), undefined);
  } finally { cleanup(); }
});

test("session-store — round-trip set + get", () => {
  const { path, cleanup } = tmpStore();
  try {
    const store = createSessionStore({ path, log: makeLog() });
    store.set("C123", "sess_abc");
    assert.strictEqual(store.get("C123"), "sess_abc");
  } finally { cleanup(); }
});

test("session-store — persists across instances", () => {
  const { path, cleanup } = tmpStore();
  try {
    const log = makeLog();
    createSessionStore({ path, log }).set("C123", "sess_xyz");
    const store2 = createSessionStore({ path, log });
    assert.strictEqual(store2.get("C123"), "sess_xyz");
  } finally { cleanup(); }
});

test("session-store — delete removes key", () => {
  const { path, cleanup } = tmpStore();
  try {
    const store = createSessionStore({ path, log: makeLog() });
    store.set("C123", "sess_abc");
    store.delete("C123");
    assert.strictEqual(store.get("C123"), undefined);
    const store2 = createSessionStore({ path, log: makeLog() });
    assert.strictEqual(store2.get("C123"), undefined);
  } finally { cleanup(); }
});

test("session-store — corrupt JSON returns empty, logs warning", () => {
  const { path, cleanup } = tmpStore();
  try {
    writeFileSync(path, "{ bad json }", "utf8");
    const log = makeLog();
    const store = createSessionStore({ path, log });
    assert.strictEqual(store.get("any"), undefined);
    assert.ok(log.warns.length > 0, "should log a warning");
  } finally { cleanup(); }
});

test("session-store — all() returns snapshot of all entries", () => {
  const { path, cleanup } = tmpStore();
  try {
    const store = createSessionStore({ path, log: makeLog() });
    store.set("C1", "s1");
    store.set("C2", "s2");
    const all = store.all();
    assert.strictEqual(all.C1, "s1");
    assert.strictEqual(all.C2, "s2");
  } finally { cleanup(); }
});

test("session-store — 10 sequential sets all persist", async () => {
  const { path, cleanup } = tmpStore();
  try {
    const store = createSessionStore({ path, log: makeLog() });
    for (let i = 0; i < 10; i++) store.set(`C${i}`, `s${i}`);
    const store2 = createSessionStore({ path, log: makeLog() });
    for (let i = 0; i < 10; i++) assert.strictEqual(store2.get(`C${i}`), `s${i}`);
  } finally { cleanup(); }
});

test("session-store — importAll merges entries and persists", () => {
  const { path, cleanup } = tmpStore();
  try {
    const store = createSessionStore({ path, log: makeLog() });
    store.set("existing", "v1");
    store.importAll({ newKey: "v2", another: "v3" });
    const store2 = createSessionStore({ path, log: makeLog() });
    assert.strictEqual(store2.get("existing"), "v1", "existing key preserved");
    assert.strictEqual(store2.get("newKey"), "v2", "imported key present");
    assert.strictEqual(store2.get("another"), "v3", "second imported key present");
  } finally { cleanup(); }
});
