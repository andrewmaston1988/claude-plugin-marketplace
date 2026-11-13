// TV CLI rows: the tv branches of run and capture, `tv probe`, and doctor's TV checks. Every
// invocation is a real child process, so the exit code is the one a user gets.

import test from "node:test";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { startFixtureServer } from "./fixtures/server.mjs";
import { findBrowser } from "../src/browser.mjs";
import {
  noSdbEnv, probe, scratchConfig, scratchDir, startCdpStub, SETTLED_PAGE,
} from "./cli-support.mjs";

// -- the TV branches --------------------------------------------------------

// The page a stub target reports as settled: the CLI's attach waits for it before any step runs.
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
