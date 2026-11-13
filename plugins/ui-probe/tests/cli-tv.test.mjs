// TV CLI rows: the tv branches of run and capture, `tv probe`, and doctor's TV checks. Every
// invocation is a real child process, so the exit code is the one a user gets.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { startFixtureServer } from "./fixtures/server.mjs";
import { findBrowser } from "../src/browser.mjs";
import {
  probe, scratchConfig, scratchDir, startCdpStub, startGuidedListenStub, TV_FEATURES,
} from "./cli-support.mjs";

// -- the TV branches --------------------------------------------------------

// sdb must not exist for any TV CLI test: an empty PATH and an empty home leave findSdb with
// nothing to find, so no real sdb can ever be spawned. The TV paths reached here never want it.
function noSdbEnv(home) {
  return { PATH: null, USERPROFILE: home, HOME: home, TEMP: home, TMP: home };
}

// The page a stub target reports as settled: the CLI's attach waits for it before any step runs.
const SETTLED_PAGE = {
  href: "http://192.0.2.30:8000/tv?tizen=1",
  origin: "http://192.0.2.30:8000",
  ready: "complete",
  hasBody: true,
};
const settling = (js) => String(js).includes("document.readyState") ? SETTLED_PAGE : undefined;

function tvScenario(dir, { name = "tv.yaml", url = "http://192.0.2.30/tv" } = {}) {
  const file = path.join(dir, name);
  writeFileSync(file, [
    "id: tv-refusal",
    "backend: tv",
    "steps:",
    `  - open: { url: "${url}" }`,
    '  - expect_text: { target: "h1", equals: "One" }',
    "",
  ].join("\n"));
  return file;
}

test("row 13: from the CLI, an include resolves beside the scenario file", async () => {
  const fixture = await startFixtureServer();
  const dir = scratchDir("ui-probe-include");
  try {
    scratchConfig(dir, { baseUrl: fixture.origin });
    writeFileSync(path.join(dir, "prefix.yaml"), [
      "id: prefix",
      "steps:",
      '  - expect_json: { url: "/json/data", path: "ok", equals: true }',
      "",
    ].join("\n"));
    const journey = path.join(dir, "journey.yaml");
    writeFileSync(journey, [
      "id: included-journey",
      "backend: http",
      "steps:",
      "  - include: prefix.yaml",
      '  - expect_json: { url: "/json/data", path: "nested.value", equals: 5 }',
      "",
    ].join("\n"));

    const validated = await probe(["validate", journey], { cwd: dir });
    assert.equal(validated.status, 0, `validate must resolve the include: ${validated.stderr}`);

    const run = await probe(["run", journey, "--out", path.join(dir, "out")], { cwd: dir });
    assert.equal(run.status, 0, `run must resolve the include: ${run.stderr}`);
    assert.match(run.stdout, /^run: passed/m, run.stdout);
    assert.equal(run.stdout.match(/^PASSED /gm)?.length, 2, "the included step and the journey's own step both ran");
  } finally {
    await fixture.close();
  }
});

test("row 1: doctor checks the tv block, or reports the tv checks skipped without one", async (t) => {
  let browser;
  try {
    browser = findBrowser({});
  } catch (error) {
    if (process.env.UI_PROBE_REQUIRE_BROWSER === "1") throw error;
    t.skip(`no Chromium browser found: ${error.message}`);
    return;
  }

  const fixture = await startFixtureServer();
  try {
    // No sdb can be found: no PATH, an empty home, so neither PATH nor the SDK layouts answer.
    // Every other check passes, so only the tv check can decide this exit code.
    const dir = scratchDir("ui-probe-doctor-tv");
    const home = scratchDir("ui-probe-doctor-tv-home");
    scratchConfig(dir, {
      baseUrl: fixture.origin,
      browser,
      tv: { host: "192.0.2.10:26101", appid: "torrenthub.main" },
    });

    const missing = await probe(["doctor"], { cwd: dir, env: noSdbEnv(home) });
    assert.notEqual(missing.status, 0, `doctor must fail when the tv block has no sdb: ${missing.stdout}`);
    assert.match(missing.stdout + missing.stderr, /tv\.sdb/, "the failing check is named tv.sdb");

    // A config with no tv block: the tv checks are skipped, and the rest still decides the exit.
    const webDir = scratchDir("ui-probe-doctor-notv");
    scratchConfig(webDir, { baseUrl: fixture.origin, browser });
    const skipped = await probe(["doctor"], { cwd: webDir });
    assert.equal(skipped.status, 0, `doctor should pass with no tv block: ${skipped.stdout}${skipped.stderr}`);
    assert.match(skipped.stdout, /^skip tv: /m, "the tv checks are reported as skipped");
  } finally {
    await fixture.close();
  }
});

test("rows 6 and 7: a tv run exits 64 with the policy's reason before it starts", async () => {
  const dir = scratchDir("ui-probe-tv-policy");
  const home = scratchDir("ui-probe-tv-policy-home");
  const env = noSdbEnv(home);
  const scenario = tvScenario(dir);
  const base = { host: "192.0.2.10:26101", appid: "torrenthub.main" };

  // --allow-writes needs a test origin to lift the block on, and the config alone can say it.
  scratchConfig(dir, { baseUrl: "http://127.0.0.1:9", tv: base });
  const noOrigin = await probe(["run", scenario, "--device", "tv", "--allow-writes"], { cwd: dir, env });
  assert.equal(noOrigin.status, 64, `exited ${noOrigin.status}: ${noOrigin.stderr}`);
  assert.match(noOrigin.stderr, /tv\.testOrigin/, noOrigin.stderr);

  // A target with neither Fetch nor Network interception cannot block a write, so a scenario that
  // wants to make one is refused before it starts rather than half-way through.
  const stub = await startCdpStub({
    protocol: { domains: [{ domain: "Page", commands: [{ name: "navigate" }] }] },
    evaluate: (js) => settling(js) ?? null,
  });
  scratchConfig(dir, {
    baseUrl: "http://127.0.0.1:9",
    tv: { ...base, testOrigin: "http://127.0.0.1:8001" },
  });
  try {
    const joined = ["--device", "tv", "--attach-port", String(stub.port)];

    const noWrites = await probe(["run", scenario, ...joined], { cwd: dir, env });
    assert.equal(noWrites.status, 64, `exited ${noWrites.status}: ${noWrites.stderr}`);
    assert.match(noWrites.stderr, /--allow-writes/, noWrites.stderr);
    assert.match(noWrites.stderr, /interception/, noWrites.stderr);

    const outside = await probe(["run", scenario, ...joined, "--allow-writes"], { cwd: dir, env });
    assert.equal(outside.status, 64, `exited ${outside.status}: ${outside.stderr}`);
    assert.match(outside.stderr, /192\.0\.2\.30/, "the offending open is named");
    assert.match(outside.stderr, /tv\.testOrigin/, outside.stderr);
  } finally {
    await stub.close();
  }
});

// The pre-flight must judge the steps the include brings in, not only the file's own.
test("row 7: an include-borne open outside tv.testOrigin is refused", async () => {
  const dir = scratchDir("ui-probe-tv-include-policy");
  const env = noSdbEnv(scratchDir("ui-probe-tv-include-policy-home"));
  writeFileSync(path.join(dir, "prefix.yaml"), [
    "id: prefix",
    "steps:",
    '  - open: { url: "http://192.0.2.30/tv" }',
    "",
  ].join("\n"));
  const scenario = path.join(dir, "journey.yaml");
  writeFileSync(scenario, [
    "id: journey",
    "backend: tv",
    "steps:",
    "  - include: prefix.yaml",
    '  - expect_text: { target: "h1", equals: "One" }',
    "",
  ].join("\n"));
  scratchConfig(dir, {
    baseUrl: "http://127.0.0.1:9",
    tv: { host: "192.0.2.10:26101", appid: "torrenthub.main", testOrigin: "http://127.0.0.1:8001" },
  });

  const stub = await startCdpStub({
    protocol: { domains: [{ domain: "Page", commands: [{ name: "navigate" }] }] },
    evaluate: (js) => settling(js) ?? null,
  });
  try {
    const result = await probe([
      "run", scenario, "--device", "tv", "--attach-port", String(stub.port), "--allow-writes",
    ], { cwd: dir, env });
    assert.equal(result.status, 64, `exited ${result.status}: ${result.stdout}${result.stderr}`);
    assert.match(result.stderr, /192\.0\.2\.30/, "the included open is named");
    assert.match(result.stderr, /tv\.testOrigin/, result.stderr);
  } finally {
    await stub.close();
  }
});

// A capture's screen steps come from the config, so their includes resolve beside it.
test("row 7: a capture screen whose only open is behind an include is judged on it", async () => {
  const dir = scratchDir("ui-probe-tv-capture-include");
  const env = noSdbEnv(scratchDir("ui-probe-tv-capture-include-home"));
  writeFileSync(path.join(dir, "prefix.yaml"), [
    "id: prefix",
    "steps:",
    '  - open: { url: "http://192.0.2.30/tv" }',
    "",
  ].join("\n"));
  scratchConfig(dir, {
    baseUrl: "http://127.0.0.1:9",
    screens: { grid: { url: "/tv", steps: [{ include: "prefix.yaml" }] } },
    tv: { host: "192.0.2.10:26101", appid: "torrenthub.main", testOrigin: "http://127.0.0.1:8001" },
  });

  // A target with neither interception: only a fully allowed, test-origin capture may start.
  const stub = await startCdpStub({
    protocol: { domains: [{ domain: "Page", commands: [{ name: "navigate" }] }] },
    evaluate: (js) => settling(js)
      ?? (String(js).includes("outerHTML") ? "<html></html>"
        : String(js).includes("SKIP") ? "body" : {}),
  });
  try {
    const result = await probe([
      "capture", "grid", "--device", "tv", "--attach-port", String(stub.port),
      "--allow-writes", "--out", path.join(dir, "out"),
    ], { cwd: dir, env });
    assert.equal(result.status, 64, `exited ${result.status}: ${result.stdout}${result.stderr}`);
    assert.match(result.stderr, /192\.0\.2\.30/, "the included open is named");
    assert.match(result.stderr, /tv\.testOrigin/, result.stderr);
  } finally {
    await stub.close();
  }
});

// A file whose includes cannot be spliced is refused, never judged on fewer steps.
test("row 7: an unsplicable include is refused with 64 on both run and capture", async () => {
  const dir = scratchDir("ui-probe-tv-include-broken");
  const env = noSdbEnv(scratchDir("ui-probe-tv-include-broken-home"));
  scratchConfig(dir, {
    baseUrl: "http://127.0.0.1:9",
    screens: { grid: { url: "/tv", steps: [{ include: "missing.yaml" }] } },
    tv: { host: "192.0.2.10:26101", appid: "torrenthub.main", testOrigin: "http://127.0.0.1:8001" },
  });
  const scenario = path.join(dir, "journey.yaml");
  writeFileSync(scenario, [
    "id: journey",
    "backend: tv",
    "steps:",
    "  - include: missing.yaml",
    '  - expect_text: { target: "h1", equals: "One" }',
    "",
  ].join("\n"));

  const run = await probe(["run", scenario, "--device", "tv"], { cwd: dir, env });
  assert.equal(run.status, 64, `exited ${run.status}: ${run.stdout}${run.stderr}`);
  assert.match(run.stderr, /missing\.yaml/, "the run names the include it could not read");

  const capture = await probe(["capture", "grid", "--device", "tv"], { cwd: dir, env });
  assert.equal(capture.status, 64, `exited ${capture.status}: ${capture.stdout}${capture.stderr}`);
  assert.match(capture.stderr, /missing\.yaml/, "the capture names the include it could not read");
});

// A --device tv run is guarded as TV work even when the file itself declares no backend.
test("row 6: a --device tv run whose file declares no backend is still TV-scoped", async () => {
  const dir = scratchDir("ui-probe-tv-scope-device");
  const home = scratchDir("ui-probe-tv-scope-device-home");
  scratchConfig(dir, {
    baseUrl: "http://127.0.0.1:9",
    tv: { host: "192.0.2.10:26101", appid: "torrenthub.main" },
  });
  const scenario = path.join(dir, "plain.yaml");
  writeFileSync(scenario, [
    "id: plain-journey",
    "steps:",
    '  - open: { url: "http://192.0.2.30/tv" }',
    '  - expect_text: { target: "h1", equals: "One" }',
    "",
  ].join("\n"));

  const result = await probe(["run", scenario, "--device", "tv", "--allow-writes"], { cwd: dir, env: noSdbEnv(home) });
  assert.equal(result.status, 64, `exited ${result.status}: ${result.stderr}`);
  assert.match(result.stderr, /tv\.testOrigin/, `the refusal names the missing test origin: ${result.stderr}`);
});

// The attach is the slow part of a TV run and the digest says what it cost before any result.
test("row 22: a TV run prints its attach timings on the digest header", async () => {
  const dir = scratchDir("ui-probe-tv-timings");
  const env = noSdbEnv(scratchDir("ui-probe-tv-timings-home"));
  scratchConfig(dir, {
    baseUrl: "http://127.0.0.1:9",
    tv: { host: "192.0.2.10:26101", appid: "torrenthub.main", testOrigin: "http://127.0.0.1:8001" },
  });
  const scenario = path.join(dir, "keys.yaml");
  writeFileSync(scenario, [
    "id: key-journey",
    "backend: tv",
    "steps:",
    '  - key: { key: "Left" }',
    '  - expect_text: { target: "h1", equals: "One" }',
    "",
  ].join("\n"));

  const stub = await startCdpStub({
    protocol: { domains: [{ domain: "Input", commands: [{ name: "dispatchKeyEvent" }] }] },
    evaluate: (js) => settling(js) ?? (String(js).includes("textContent") ? { found: true, value: "One" } : null),
  });
  try {
    const result = await probe([
      "run", scenario, "--device", "tv", "--attach-port", String(stub.port), "--allow-writes",
    ], { cwd: dir, env });
    assert.equal(result.status, 0, `exited ${result.status}: ${result.stdout}${result.stderr}`);
    const header = result.stdout.split("\n")[0];
    assert.match(header, /^tv attach: \d+ ms, relaunch: n\/a, settle: \d+ ms$/, `the header: ${header}`);
  } finally {
    await stub.close();
  }
});

test("row 9: --device defaults to the desktop device", async (t) => {
  let browser;
  try {
    browser = findBrowser({});
  } catch (error) {
    if (process.env.UI_PROBE_REQUIRE_BROWSER === "1") throw error;
    t.skip(`no Chromium browser found: ${error.message}`);
    return;
  }

  const fixture = await startFixtureServer();
  const dir = scratchDir("ui-probe-tv-default-device");
  // The tv block points at an unreachable address: taking the tv path would exit non-zero.
  scratchConfig(dir, {
    baseUrl: fixture.origin,
    browser,
    viewports: { desktop: { width: 1280, height: 900 } },
    tv: { host: "192.0.2.10:26101", appid: "torrenthub.main" },
  });
  const scenario = path.join(dir, "grid.yaml");
  writeFileSync(scenario, [
    "id: tv-default-device",
    "backend: tv",
    "steps:",
    `  - open: { url: "${fixture.path("/tv-grid.html")}" }`,
    // The exact safe box of 1920x1080: only the desk device's emulation puts it inside.
    '  - expect_within: { target: "#probe-safe", box: "safe", timeoutMs: 0 }',
    "",
  ].join("\n"));

  try {
    const result = await probe(["run", scenario, "--out", path.join(dir, "out")], { cwd: dir });
    assert.equal(result.status, 0, `a tv journey without --device must run on the desktop: ${result.stderr}`);
    assert.match(result.stdout, /^run: passed/m, result.stdout);
  } finally {
    await fixture.close();
  }
});

test("row 9: an unknown --device is refused with 64", async () => {
  const dir = scratchDir("ui-probe-tv-device-flag");
  scratchConfig(dir, { baseUrl: "http://127.0.0.1:9" });
  const scenario = tvScenario(dir);
  const result = await probe(["run", scenario, "--device", "toaster"], { cwd: dir });
  assert.equal(result.status, 64, `exited ${result.status}: ${result.stderr}`);
  assert.match(result.stderr, /--device must be tv or desktop/, result.stderr);
});

test("tv probe attaches, writes platform.json to both homes and ends on the verdict line", async () => {
  const dir = scratchDir("ui-probe-tv-probe-cli");
  const home = scratchDir("ui-probe-tv-probe-home");
  const env = noSdbEnv(home);
  const outDir = path.join(dir, "out");
  const appid = "torrenthub.main";
  scratchConfig(dir, {
    baseUrl: "http://127.0.0.1:9",
    tv: { host: "192.0.2.10:26101", appid },
  });

  const stub = await startCdpStub({
    protocol: { domains: [{ domain: "Page" }, { domain: "Network" }] },
    // The app exits under the probe: the inspector goes with it.
    onEvaluated: (js) => (js.includes(".exit()") ? "close" : undefined),
    evaluate: (expression) => {
      const js = String(expression);
      if (js.includes("document.readyState")) return SETTLED_PAGE;
      if (js.includes("credentials: 'include'")) {
        return { httpStatus: 200, type: "cors", allowOrigin: "http://192.0.2.30:8000", allowCredentials: null };
      }
      if (js.includes(".exit()")) return "called";
      if (js.includes("IntersectionObserver")) return TV_FEATURES;
      if (js.includes("__uiProbeKey.read")) return [];
      if (js.includes("__uiProbeKey = {")) return { active: "BODY" };
      if (js.includes("data-ui-probe-focus")) return true;
      return null;
    },
  });

  try {
    const result = await probe(
      ["tv", "probe", "--attach-port", String(stub.port), "--out", outDir,
        "--fetch", "http://127.0.0.1:8001/session", "--exit"],
      { cwd: dir, env },
    );
    assert.equal(result.status, 0, `tv probe exited ${result.status}: ${result.stderr}`);

    const written = JSON.parse(readFileSync(path.join(outDir, "platform.json"), "utf8"));
    assert.equal(written.schema, "ui-probe-platform@1");
    assert.equal(typeof written.timings.attachMs, "number", "the attach cost is recorded");
    assert.equal(typeof written.timings.settleMs, "number", "the settle wait is recorded beside it");
    assert.equal(written.timings.relaunchMs, null, "a join has no relaunch to time");
    const cached = path.join(home, "ui-probe", `platform-${appid}.json`);
    assert.equal(JSON.parse(readFileSync(cached, "utf8")).verdict, written.verdict, "capture reads this copy");

    assert.equal(written.fetch.status, "measured");
    assert.equal(written.fetch.httpStatus, 200);
    assert.equal(written.fetch.url, "http://127.0.0.1:8001/session");

    const lines = result.stdout.trimEnd().split("\n");
    assert.match(lines.at(-1), /^shell: /, `the digest ends on the verdict line: ${lines.at(-1)}`);
    assert.match(result.stdout, /^out: /m, "the digest names its output directory");
    assert.match(result.stdout, /^fetch: 200 /m, "the digest reports the fetch");
    assert.equal(written.exit.closed, true, "the app closed within 3 s");
    assert.match(result.stdout, /^exit: closed true/m, "the digest reports the exit");
  } finally {
    await stub.close();
  }
});

// --exit and --fetch reach the probe, and the socket is detached even when the app closed.
test("row 26: tv probe hands --exit and --fetch to the probe and detaches afterwards", async () => {
  const { tvProbeCommand } = await import("../src/tv/cli.mjs");
  const dir = scratchDir("ui-probe-tv-exit-unit");
  let detached = 0;
  let seen = null;
  const _attach = async () => ({
    cdp: {}, port: 1, protocol: null, timings: { attachMs: 5, relaunchMs: null },
    detach: async () => { detached += 1; },
  });
  const _tvProbe = async (cdp, options) => {
    seen = options;
    return {
      schema: "ui-probe-platform@1",
      page: { href: "file:///index.html", origin: "null" },
      fetch: { status: "skipped" },
      exit: { status: "measured", closed: true, ms: 12 },
      verdict: "shell: no tizen — absent",
    };
  };

  const result = await tvProbeCommand({
    config: { tv: { host: "192.0.2.10:26101", appid: "example.app" }, outDir: dir },
    outDir: dir,
    exit: true,
    fetch: "http://192.0.2.30:8000/session",
    _attach,
    _tvProbe,
  });

  assert.equal(seen.exit, true);
  assert.equal(seen.fetch, "http://192.0.2.30:8000/session");
  assert.equal(detached, 1, "detach ran after the app was asked to exit");
  assert.match(result.lines.at(-1), /^shell: /);
});

// The key list and the per-key wait are printed before the first banner, so the operator knows
// what to press and how long they have.
test("row 27: tv probe --listen prints the key list and wait, then runs the guided check", async () => {
  const dir = scratchDir("ui-probe-tv-listen-cli");
  const env = noSdbEnv(scratchDir("ui-probe-tv-listen-cli-home"));
  const outDir = path.join(dir, "out");
  scratchConfig(dir, {
    baseUrl: "http://127.0.0.1:9",
    tv: { host: "192.0.2.10:26101", appid: "torrenthub.main" },
  });

  const { prompts, port, close } = await startGuidedListenStub({
    settledPage: SETTLED_PAGE,
    pressed: { Left: [{ type: "keydown", key: "ArrowLeft", code: "ArrowLeft", keyCode: 37 }] },
  });

  try {
    const result = await probe(
      ["tv", "probe", "--attach-port", String(port), "--listen", "--listen-wait", "0.2", "--out", outDir],
      { cwd: dir, env },
    );
    assert.equal(result.status, 0, `tv probe exited ${result.status}: ${result.stderr}`);

    const said = result.stdout.split("\n");
    const announce = said.findIndex((line) => /press Left, Right, 1, Play on the remote/.test(line));
    assert.ok(announce >= 0, `the CLI names the keys before the window opens: ${result.stdout}`);
    assert.match(said[announce], /0\.2s each/, "and the wait per key");
    const outLine = said.findIndex((line) => /^out: /.test(line));
    assert.ok(announce < outLine, "the list is printed during the run, not in the digest after it");

    assert.deepEqual(prompts, ["Left", "Right", "1", "Play"], "the overlay names each key in order");

    const written = JSON.parse(readFileSync(path.join(outDir, "platform.json"), "utf8"));
    assert.equal(written.listen.status, "measured");
    assert.deepEqual(written.listen.results.map((entry) => entry.key), ["Left", "Right", "Digit1", "MediaPlay"]);
    assert.equal(written.listen.results[0].received, true);
    assert.equal(written.listen.results[1].received, false);
    assert.match(result.stdout, /^listen: 1\/4 keys received in 0\.2s each/m, result.stdout);
  } finally {
    await close();
  }
});

// A bare number used to be the wait and is now an unknown key, so the refusal points at
// --listen-wait where the wait moved.
test("row 27: --listen refuses an unknown key name and a bare number", async () => {
  const dir = scratchDir("ui-probe-tv-listen-flags");
  const env = noSdbEnv(scratchDir("ui-probe-tv-listen-flags-home"));
  scratchConfig(dir, {
    baseUrl: "http://127.0.0.1:9",
    tv: { host: "192.0.2.10:26101", appid: "torrenthub.main" },
  });

  const unknown = await probe(["tv", "probe", "--listen", "Nope"], { cwd: dir, env });
  assert.equal(unknown.status, 64, `exited ${unknown.status}: ${unknown.stderr}`);
  assert.match(unknown.stderr, /Nope/);
  assert.match(unknown.stderr, /Left, Up, Right/, "the refusal lists the key names it accepts");

  const seconds = await probe(["tv", "probe", "--listen", "30"], { cwd: dir, env });
  assert.equal(seconds.status, 64, `exited ${seconds.status}: ${seconds.stderr}`);
  assert.match(seconds.stderr, /--listen-wait/);

  const waitAlone = await probe(["tv", "probe", "--listen-wait", "3"], { cwd: dir, env });
  assert.equal(waitAlone.status, 64, `exited ${waitAlone.status}: ${waitAlone.stderr}`);
  assert.match(waitAlone.stderr, /--listen-wait only means something with --listen/);
});

// An unreadable protocol is only "no interception" on the set; on the web path a null protocol
// still means a modern browser, because the protocol is never requested there.
test("row 7: an unreadable protocol on the TV counts as no interception", async () => {
  const { tvSession } = await import("../src/tv/cli.mjs");
  const attachTo = (protocol) => async () => ({ cdp: {}, port: 43411, protocol, detach: async () => {} });
  const config = { tv: { host: "192.0.2.10:26101", appid: "torrenthub.main" } };

  assert.equal((await tvSession(config, { _attach: attachTo(null) })).intercepted, false);
  assert.equal((await tvSession(config, {
    _attach: attachTo({ domains: [{ domain: "Network", commands: [{ name: "setRequestInterception" }] }] }),
  })).intercepted, true);
});
