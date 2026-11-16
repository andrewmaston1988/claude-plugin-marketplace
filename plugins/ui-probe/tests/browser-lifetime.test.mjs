// Real-browser rows for the browser lifetime: a probe that dies without close() must not
// leave a browser behind, and a launch that fails after the spawn must end what it started.
// Without a Chromium browser these rows skip, printing why, like integration.test.mjs.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, readFileSync, rmSync, mkdtempSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";

import { findBrowser, launch } from "../src/browser.mjs";
import { killBrowserForProfile, listProcesses, profileFromCommandLine, reapOrphans } from "../src/reaper.mjs";

const REQUIRED = process.env.UI_PROBE_REQUIRE_BROWSER === "1";
const OVERRIDE = process.env.UI_PROBE_BROWSER || undefined;
const HOLD_DEADLINE_MS = 10_000;
const POLL_MS = 250;

let browserPath = null;
let browserProblem = null;
try {
  browserPath = findBrowser({ browser: OVERRIDE });
} catch (error) {
  browserProblem = error.message;
}

const SKIP = browserPath ? false : `${browserProblem} (set UI_PROBE_REQUIRE_BROWSER=1 to fail instead of skip)`;
if (!browserPath) console.log(`browser-lifetime: no browser — ${browserProblem}`);

const wait = (ms) => new Promise((done) => setTimeout(done, ms));

const fold = (path) => {
  const absolute = resolve(String(path)).replace(/\\/g, "/").replace(/\/+$/, "");
  return process.platform === "win32" ? absolute.toLowerCase() : absolute;
};

// The real listing: every process holding this exact profile, renderer children included.
function holdersOf(profile) {
  const target = fold(profile);
  return listProcesses().filter((entry) => {
    const found = profileFromCommandLine(entry.cmd);
    return found != null && fold(found) === target;
  });
}

async function nobodyHolds(profile, deadlineMs = HOLD_DEADLINE_MS) {
  const started = Date.now();
  for (;;) {
    const holders = holdersOf(profile);
    if (holders.length === 0) return;
    if (Date.now() - started >= deadlineMs) {
      assert.fail(`${holders.length} process(es) still hold ${profile}: ${JSON.stringify(holders)}`);
    }
    await wait(POLL_MS);
  }
}

// A nested node must not inherit this runner's test context.
function childEnv(extra) {
  const env = { ...process.env, ...extra };
  delete env.NODE_TEST_CONTEXT;
  return env;
}

const BROWSER_URL = pathToFileURL(fileURLToPath(new URL("../src/browser.mjs", import.meta.url))).href;

// The child launches, names its profile, then hangs: only being killed ends it, and nothing
// it owns runs close().
const CHILD_SCRIPT = `
(async () => {
  const { launch } = await import(${JSON.stringify(BROWSER_URL)});
  const session = await launch({ browser: process.env.UI_PROBE_BROWSER });
  process.stdout.write("PROFILE " + session.profile + "\\n");
  setInterval(() => {}, 1000);
})().catch((error) => { console.error(error); process.exit(1); });
`;

function startProbe() {
  const child = spawn(process.execPath, ["-e", CHILD_SCRIPT], {
    env: childEnv({ UI_PROBE_BROWSER: browserPath }),
    stdio: ["ignore", "pipe", "pipe"],
  });
  const output = [];
  const profile = new Promise((done, fail) => {
    let buffered = "";
    child.stdout.on("data", (chunk) => {
      const text = String(chunk);
      output.push(text);
      buffered += text;
      const line = buffered.split(/\r?\n/).find((part) => part.startsWith("PROFILE "));
      if (line) done(line.slice("PROFILE ".length).trim());
    });
    child.stderr.on("data", (chunk) => output.push(String(chunk)));
    child.on("error", fail);
    child.on("exit", (code) => fail(new Error(`the probe exited (${code}) before naming a profile: ${output.join("")}`)));
  });
  return { child, profile, output };
}

if (!browserPath && REQUIRED) {
  test("a Chromium browser is required but was not found", () => {
    assert.fail(`UI_PROBE_REQUIRE_BROWSER=1 and ${browserProblem}`);
  });
}

test("row 1: a killed probe's browser is ended by the next launch's reaper", { skip: SKIP, timeout: 240000 }, async () => {
  const probe = startProbe();
  const profile = await probe.profile;
  let reaped = null;
  let next = null;
  try {
    // No close(): the owner simply disappears, which is what a killed session leaves.
    probe.child.kill();
    await new Promise((done) => probe.child.once("exit", done));

    next = await launch({
      browser: browserPath,
      _reap: async () => {
        reaped = await reapOrphans();
      },
    });
    assert.ok(reaped, "the next launch ran the reaper");
    assert.ok(
      reaped.killed.length > 0,
      `the reaper stopped the orphan rather than finding nothing: ${JSON.stringify(reaped)}`,
    );
    await nobodyHolds(profile);
  } finally {
    if (next) await next.close();
    if (existsSync(profile)) {
      await killBrowserForProfile(profile);
      try { rmSync(profile, { recursive: true, force: true }); } catch { /* a failing cleanup must not mask the row */ }
    }
    if (probe.child.exitCode == null) probe.child.kill();
  }
});

test("row 2: a launch that fails after the spawn ends its browser and retries the profile removal", { skip: SKIP, timeout: 240000 }, async () => {
  const real = { mkdtempSync, existsSync, readFileSync, rmSync };
  const attempts = [];
  const fs = {
    ...real,
    // Windows holds the folder for a moment after the browser goes; the first attempt is the
    // one that must not be the only attempt.
    rmSync: (path, options) => {
      attempts.push(path);
      if (attempts.length === 1) throw new Error("EBUSY");
      real.rmSync(path, options);
    },
  };

  const launched = launch({
    browser: browserPath,
    _fs: fs,
    _fetch: async () => { throw new Error("connect refused"); },
  });

  try {
    await assert.rejects(launched, /connect refused/);
    assert.ok(attempts.length >= 2, `the removal retried: ${attempts.length} attempt(s)`);
    assert.equal(existsSync(attempts[0]), false, `the profile was removed: ${attempts[0]}`);
    await nobodyHolds(attempts[0]);
  } finally {
    // A row that fails here has just leaked the browser it is complaining about.
    const leaked = attempts[0];
    if (leaked && existsSync(leaked)) {
      await killBrowserForProfile(leaked);
      try { rmSync(leaked, { recursive: true, force: true }); } catch { /* a failing cleanup must not mask the row */ }
    }
  }
});
