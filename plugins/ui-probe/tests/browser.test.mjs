import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { findBrowser, launch } from "../src/browser.mjs";

const PROFILE = "C:/tmp/ui-probe-profile-abc";
const BROWSER_WS = "ws://127.0.0.1:9333/devtools/browser/abc";
const PAGE_WS = "ws://127.0.0.1:9333/devtools/page/xyz";

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

function launchWith({ answers = 2, child = fakeChild(), fs = fakeFs(), reap, kill, writeOwner } = {}) {
  let fetched = 0;
  const fetchUrls = [];
  const { sockets, _WebSocket } = fakeSocket();
  const events = [];
  const calls = { reaps: 0, kills: [], owners: [], spawns: [] };
  const deps = {
    browser: "C:/Program Files/Microsoft/Edge/Application/msedge.exe",
    _spawn: () => {
      events.push("spawn");
      calls.spawns.push(true);
      return child;
    },
    _fetch: async (url) => {
      fetchUrls.push(url);
      if (url.endsWith("/json/list")) {
        return { json: async () => [{ type: "page", webSocketDebuggerUrl: PAGE_WS }] };
      }
      fetched += 1;
      if (fetched > answers) throw new Error("connection refused");
      return { json: async () => ({ webSocketDebuggerUrl: BROWSER_WS }) };
    },
    _fs: fs,
    _WebSocket,
    _sleep: instant,
    _reap: async (options) => {
      events.push("reap");
      calls.reaps += 1;
      return reap ? await reap(options) : undefined;
    },
    _kill: async (profile) => {
      calls.kills.push(profile);
      return kill ? await kill(profile) : undefined;
    },
    _writeOwner: (profile, ...rest) => {
      events.push("owner");
      calls.owners.push([profile, ...rest]);
      if (writeOwner) writeOwner(profile, ...rest);
    },
  };
  return { deps, fs, child, sockets, events, calls, fetches: () => fetchUrls };
}

test("U1 retries transient DevToolsActivePort read failures", async () => {
  const fs = fakeFs();
  let reads = 0;
  fs.readFileSync = () => {
    reads += 1;
    if (reads <= 3) throw Object.assign(new Error("locked"), { code: "EBUSY" });
    return "9333\n/devtools/browser/abc";
  };
  const { deps } = launchWith({ fs });
  const session = await launch(deps);
  assert.equal(session.port, 9333);
});

test("U2 names a persistent port-file read failure at the poll budget", async () => {
  const fs = fakeFs();
  let reads = 0;
  fs.readFileSync = () => { reads += 1; throw Object.assign(new Error("locked"), { code: "EBUSY" }); };
  const { deps } = launchWith({ fs });
  let error;
  try { await launch(deps); } catch (caught) { error = caught; }
  assert.ok(reads > 1, `expected repeated reads, got ${reads}`);
  assert.match(error.message, /browser never wrote DevToolsActivePort.*EBUSY/);
});

test("U3 names a persistent port-file read failure at launcher early exit", async () => {
  const fs = fakeFs();
  fs.readFileSync = () => { throw Object.assign(new Error("locked"), { code: "EBUSY" }); };
  const child = fakeChild();
  child.exitCode = 0;
  const { deps } = launchWith({ fs, child });
  let now = 0;
  deps._now = () => { now += 9000; return now; };
  await assert.rejects(launch(deps), /browser exited early.*EBUSY/);
});

test("U4 keeps polling until the port file has its second line", async () => {
  const fs = fakeFs();
  let reads = 0;
  fs.readFileSync = () => ++reads <= 3 ? "9" : "9333\n/devtools/browser/abc";
  const { deps } = launchWith({ fs });
  const session = await launch(deps);
  assert.equal(session.port, 9333);
  assert.equal(reads, 4);
});

test("launch returns the port, the browser socket, the profile and a close", async () => {
  const { deps } = launchWith();
  const session = await launch(deps);
  assert.equal(session.port, 9333);
  assert.equal(session.profile, PROFILE);
  assert.equal(typeof session.browserWs.send, "function");
  assert.equal(typeof session.attachPage, "function");
  assert.equal(typeof session.close, "function");
});

test("attachPage attaches a page-level client over the port, once", async () => {
  const { deps, sockets } = launchWith();
  const session = await launch(deps);
  const page = await session.attachPage();
  assert.equal(typeof page.send, "function");
  assert.equal(sockets.at(-1).url, PAGE_WS, "the attached client is a page target, not the browser socket");
  assert.equal(await session.attachPage(), page, "a second attach reuses the client");
});

test("the reaper runs before the owner file is written and the browser is spawned", async () => {
  const { deps, events, calls } = launchWith();
  const session = await launch(deps);
  assert.deepEqual(events, ["reap", "owner", "spawn"]);
  assert.deepEqual(calls.owners, [[PROFILE]]);
  await session.close();
});

test("a rejecting reaper does not fail the launch, but is named", async () => {
  const { deps } = launchWith({ reap: async () => { throw new Error("lister blew up"); } });
  const warnings = [];
  const original = console.warn;
  console.warn = (message) => warnings.push(String(message));
  let session;
  try {
    session = await launch(deps);
  } finally {
    console.warn = original;
  }
  assert.equal(session.port, 9333);
  assert.match(warnings.join("\n"), /the reap failed \(lister blew up\)/);
  await session.close();
});

test("a reaper that overruns its budget does not hold up the launch, and is named", { timeout: 15000 }, async () => {
  const { deps } = launchWith({ reap: () => new Promise(() => {}) });
  const warnings = [];
  const original = console.warn;
  console.warn = (message) => warnings.push(String(message));
  let session;
  try {
    session = await launch(deps);
  } finally {
    console.warn = original;
  }
  assert.equal(session.port, 9333);
  assert.match(warnings.join("\n"), /overran its 5000 ms budget/);
  await session.close();
});

test("launch logs one line when the reap did something and nothing on a clean machine", async () => {
  const cases = [
    { reap: { skipped: "prescan", killed: [], failed: [], swept: [] }, expected: null },
    {
      reap: { skipped: null, killed: [1, 2], failed: [], swept: ["p"] },
      expected: /reaped 2 orphaned browsers; swept 1 profile folder/,
    },
    { reap: { skipped: null, killed: [], failed: [7], swept: [] }, expected: /could not stop 1 browser/ },
    {
      reap: { skipped: "listing-failed", killed: [], failed: [], swept: [] },
      expected: /skipped \(listing-failed\)/,
    },
  ];
  for (const { reap, expected } of cases) {
    const { deps } = launchWith({ reap: async () => reap });
    const warnings = [];
    const original = console.warn;
    console.warn = (message) => warnings.push(String(message));
    let session;
    try {
      session = await launch(deps);
    } finally {
      console.warn = original;
    }
    await session.close();
    if (expected) assert.match(warnings.join("\n"), expected);
    else assert.deepEqual(warnings, [], "a clean, empty reap says nothing");
  }
});

test("close sends Browser.close, waits for the port to stop answering, then removes the profile", async () => {
  const { deps, fs, child, sockets, fetches, calls } = launchWith({ answers: 2 });
  const session = await launch(deps);
  await session.close();

  assert.deepEqual(sockets.at(-1).sent.map((frame) => frame.method), ["Browser.close"]);
  assert.equal(fetches().filter((url) => url.endsWith("/json/version")).length, 3);
  assert.deepEqual(fs.removed, [PROFILE]);
  assert.deepEqual(calls.kills, [], "a browser that went quiet is not killed");
  assert.equal(child.kills, 0);
});

test("a port still answering after the poll window warns, kills by profile, then removes the profile", async () => {
  const { deps, fs, calls } = launchWith({ answers: Number.POSITIVE_INFINITY });
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
  assert.deepEqual(calls.kills, [PROFILE]);
  assert.deepEqual(fs.removed, [PROFILE]);
});

test("a kill the module could not verify leaves the profile folder for the next reap", async () => {
  const { deps, fs, calls } = launchWith({
    answers: Number.POSITIVE_INFINITY,
    kill: async () => ({ killed: [], failed: [4001] }),
  });
  const session = await launch(deps);
  const warnings = [];
  const original = console.warn;
  console.warn = (message) => warnings.push(String(message));
  try {
    await session.close();
  } finally {
    console.warn = original;
  }
  assert.deepEqual(calls.kills, [PROFILE]);
  assert.deepEqual(fs.removed, [], "an unverified kill is not grounds to delete the profile");
  assert.match(warnings.join("\n"), /kept the browser profile/);
});

test("a launch that fails after the spawn keeps the profile when the kill is unverified", async () => {
  const fs = fakeFs();
  fs.existsSync = (path) => path.endsWith("msedge.exe");
  const { deps } = launchWith({ fs, kill: async () => ({ killed: [], failed: [4001] }) });
  await assert.rejects(launch(deps), /DevToolsActivePort/);
  assert.deepEqual(fs.removed, [], "the folder stays for the next reap");
});

test("A3: an unverified kill after an ignored Browser.close keeps the profile folder", async () => {
  const { deps, fs, calls } = launchWith({
    answers: Number.POSITIVE_INFINITY,
    kill: async () => ({ killed: [], failed: [], unverified: true }),
  });
  const session = await launch(deps);
  const warnings = [];
  const original = console.warn;
  console.warn = (message) => warnings.push(String(message));
  try {
    await session.close();
  } finally {
    console.warn = original;
  }
  assert.deepEqual(calls.kills, [PROFILE]);
  assert.deepEqual(fs.removed, [], "an unverified kill is not grounds to delete the profile");
  assert.match(warnings.join("\n"), /kept the browser profile/);
});

test("A3b: a launch that fails after the spawn keeps the profile when the kill is unverified", async () => {
  const fs = fakeFs();
  fs.existsSync = (path) => path.endsWith("msedge.exe");
  const { deps } = launchWith({ fs, kill: async () => ({ killed: [], failed: [], unverified: true }) });
  await assert.rejects(launch(deps), /DevToolsActivePort/);
  assert.deepEqual(fs.removed, [], "the folder stays for the next reap");
});

test("A4: a kill whose listing ran and found nothing still removes the profile", async () => {
  const { deps, fs } = launchWith({
    answers: Number.POSITIVE_INFINITY,
    kill: async () => ({ killed: [], failed: [] }),
  });
  const session = await launch(deps);
  const warnings = [];
  const original = console.warn;
  console.warn = (message) => warnings.push(String(message));
  try {
    await session.close();
  } finally {
    console.warn = original;
  }
  assert.deepEqual(fs.removed, [PROFILE], "a verified no-match is still a verified kill");
  assert.ok(!warnings.some((line) => /kept the browser profile/.test(line)));
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
  // Pin the platform each half exercises: the host's own would decide which half can pass.
  const looked = [];
  const found = findBrowser({
    _platform: "win32",
    _exists: (path) => path.endsWith("msedge.exe") && path.includes("Program Files"),
    _spawnSync: (command, args) => {
      looked.push([command, args[0]]);
      return { stdout: "" };
    },
  });
  assert.match(found, /msedge\.exe$/);

  const viaPath = findBrowser({
    _platform: "linux",
    _exists: (path) => path === "/usr/bin/google-chrome",
    _spawnSync: (command, [name]) => {
      looked.push([command, name]);
      return { stdout: name === "google-chrome" ? "/usr/bin/google-chrome\n" : "" };
    },
  });
  assert.equal(viaPath, "/usr/bin/google-chrome");
  assert.ok(looked.some(([, name]) => name === "google-chrome"));
  assert.ok(looked.some(([command]) => command === "which"), "the linux half looks up via which");
});

test("no browser found is an actionable error", () => {
  assert.throws(
    () => findBrowser({ _exists: () => false, _spawnSync: () => ({ stdout: "" }) }),
    /no Chromium browser found/,
  );
});

test("a launch that fails after the spawn kills the browser and retries the profile removal", async () => {
  const fs = fakeFs();
  // The port file never appears: existsSync answers only for the browser binary.
  fs.existsSync = (path) => path.endsWith("msedge.exe");
  let attempts = 0;
  const rmSync = fs.rmSync;
  fs.rmSync = (path) => {
    attempts += 1;
    if (attempts < 3) throw new Error("EBUSY");
    rmSync(path);
  };
  const child = fakeChild();
  const { deps, calls } = launchWith({ child, fs });
  await assert.rejects(launch(deps), /DevToolsActivePort/);
  assert.deepEqual(calls.kills, [PROFILE]);
  assert.equal(attempts, 3, "the profile removal retries before giving up");
  assert.deepEqual(fs.removed, [PROFILE]);
  assert.equal(child.kills, 0, "the launcher stub's PID is never killed");
});

test("the module never kills a process itself", () => {
  const source = readFileSync(fileURLToPath(new URL("../src/browser.mjs", import.meta.url)), "utf8");
  for (const banned of ["process.kill(", "child.kill(", "Stop-Process"]) {
    assert.ok(!source.includes(banned), `every kill goes through the injected killer; found ${banned}`);
  }
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
