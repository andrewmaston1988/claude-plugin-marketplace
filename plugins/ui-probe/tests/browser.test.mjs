import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { findBrowser, launch } from "../src/browser.mjs";

const PROFILE = "C:/tmp/ui-probe-profile-abc";

function fakeFs({ profileRemovable = true } = {}) {
  const removed = [];
  return {
    removed,
    mkdtempSync: () => PROFILE,
    existsSync: (path) => path.endsWith("msedge.exe") || path.endsWith("DevToolsActivePort"),
    readFileSync: () => "9333\n/devtools/browser/abc",
    rmSync: (path) => {
      if (!profileRemovable) throw new Error("EBUSY");
      removed.push(path);
    },
  };
}

function fakeSocket() {
  const sockets = [];
  class Recorded extends EventTarget {
    constructor(url) {
      super();
      this.url = url;
      this.sent = [];
      sockets.push(this);
      queueMicrotask(() => this.dispatchEvent(new Event("open")));
    }

    send(frame) {
      const parsed = JSON.parse(frame);
      this.sent.push(parsed);
      queueMicrotask(() => {
        this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify({ id: parsed.id, result: {} }) }));
      });
    }

    close() {}
  }
  return { sockets, _WebSocket: Recorded };
}

function fakeChild() {
  const child = { pid: 111, exitCode: null, kills: 0, kill() { child.kills += 1; } };
  return child;
}

const instant = async () => {};

function launchWith({ answers = 2, child = fakeChild(), fs = fakeFs() } = {}) {
  let fetched = 0;
  const fetchUrls = [];
  const { sockets, _WebSocket } = fakeSocket();
  const deps = {
    browser: "C:/Program Files/Microsoft/Edge/Application/msedge.exe",
    _spawn: () => child,
    _fetch: async (url) => {
      fetchUrls.push(url);
      fetched += 1;
      if (fetched > answers) throw new Error("connection refused");
      return { json: async () => ({ webSocketDebuggerUrl: "ws://127.0.0.1:9333/devtools/browser/abc" }) };
    },
    _fs: fs,
    _WebSocket,
    _sleep: instant,
  };
  return { deps, fs, child, sockets, fetches: () => fetchUrls };
}

test("launch returns the port, the browser socket and a close", async () => {
  const { deps } = launchWith();
  const session = await launch(deps);
  assert.equal(session.port, 9333);
  assert.equal(typeof session.browserWs.send, "function");
  assert.equal(typeof session.close, "function");
});

test("close sends Browser.close, waits for the port to stop answering, then removes the profile", async () => {
  const { deps, fs, child, sockets, fetches } = launchWith({ answers: 2 });
  const session = await launch(deps);
  await session.close();

  assert.deepEqual(sockets.at(-1).sent.map((frame) => frame.method), ["Browser.close"]);
  assert.equal(fetches().filter((url) => url.endsWith("/json/version")).length, 3);
  assert.deepEqual(fs.removed, [PROFILE]);
  assert.equal(child.kills, 0);
});

test("a port still answering after the poll window warns and still removes the profile", async () => {
  const { deps, fs } = launchWith({ answers: Number.POSITIVE_INFINITY });
  const session = await launch(deps);
  const warnings = [];
  const original = console.warn;
  console.warn = (message) => warnings.push(String(message));
  try {
    await session.close();
  } finally {
    console.warn = original;
  }
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /9333 still answering/);
  assert.deepEqual(fs.removed, [PROFILE]);
});

test("the profile removal is retried when the first attempt fails", async () => {
  let attempts = 0;
  const fs = fakeFs();
  const rmSync = fs.rmSync;
  fs.rmSync = (path) => {
    attempts += 1;
    if (attempts < 3) throw new Error("EBUSY");
    rmSync(path);
  };
  const { deps } = launchWith({ answers: 1, fs });
  const session = await launch(deps);
  await session.close();
  assert.equal(attempts, 3);
  assert.deepEqual(fs.removed, [PROFILE]);
});

test("an explicit browser wins, and a missing one is named rather than silently replaced", async () => {
  const found = findBrowser({
    browser: "C:/browsers/chrome.exe",
    _exists: (path) => path === "C:/browsers/chrome.exe",
  });
  assert.equal(found, "C:/browsers/chrome.exe");

  assert.throws(
    () => findBrowser({ browser: "C:/browsers/missing.exe", _exists: () => false }),
    /C:\/browsers\/missing\.exe/,
  );
});

test("discovery falls back to the platform candidates and then to PATH", () => {
  const looked = [];
  const found = findBrowser({
    _exists: (path) => path.endsWith("msedge.exe") && path.includes("Program Files"),
    _spawnSync: (command, args) => {
      looked.push([command, args[0]]);
      return { stdout: "" };
    },
  });
  assert.match(found, /msedge\.exe$/);

  const viaPath = findBrowser({
    _exists: (path) => path === "/usr/bin/google-chrome",
    _spawnSync: (command, [name]) => {
      looked.push([command, name]);
      return { stdout: name === "google-chrome" ? "/usr/bin/google-chrome\n" : "" };
    },
  });
  assert.equal(viaPath, "/usr/bin/google-chrome");
  assert.ok(looked.some(([, name]) => name === "google-chrome"));
});

test("no browser found is an actionable error", () => {
  assert.throws(
    () => findBrowser({ _exists: () => false, _spawnSync: () => ({ stdout: "" }) }),
    /no Chromium browser found/,
  );
});

test("launch removes the profile when no DevToolsActivePort appears", async () => {
  const fs = fakeFs();
  // The port file never appears: existsSync answers only for the browser binary.
  fs.existsSync = (path) => path.endsWith("msedge.exe");
  const child = fakeChild();
  const { deps } = launchWith({ child, fs });
  await assert.rejects(launch(deps), /DevToolsActivePort/);
  assert.deepEqual(fs.removed, [PROFILE]);
  assert.equal(child.kills, 0);
});

test("the module never kills a process", () => {
  const source = readFileSync(fileURLToPath(new URL("../src/browser.mjs", import.meta.url)), "utf8");
  assert.doesNotMatch(source, /\.kill\(|process\.kill/);
});

test("a profile that cannot be removed is named rather than silently left behind", async () => {
  const fs = fakeFs();
  const attempted = [];
  fs.rmSync = (path) => { attempted.push(path); throw new Error("EBUSY"); };
  const { deps } = launchWith({ answers: 1, fs });
  const session = await launch(deps);
  const warnings = [];
  const original = console.warn;
  console.warn = (message) => warnings.push(String(message));
  try {
    await session.close();
  } finally {
    console.warn = original;
  }
  assert.equal(attempted.length, 5);
  assert.match(warnings.join("\n"), /could not remove the browser profile/);
});
