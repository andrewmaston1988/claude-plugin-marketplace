// CLI rows: run exit codes, lazy module loading, doctor's named checks. Every invocation is a
// real child process so the exit code and the loaded-module set are the ones a user gets.

import test from "node:test";
import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { startFixtureServer } from "./fixtures/server.mjs";
import { findBrowser } from "../src/browser.mjs";

const execFile = promisify(execFileCallback);
const PLUGIN = fileURLToPath(new URL("..", import.meta.url));
const BIN = path.join(PLUGIN, "bin", "ui-probe.mjs");
const HEAVY_MODULES = ["browser.mjs", "cdp.mjs", "capture.mjs", "runner.mjs"];

// Async spawn, never spawnSync: the fixture server lives in this process's event loop, and a
// synchronous child would block it until every baseUrl check timed out.
async function probe(args, { cwd = PLUGIN, hook = false, log = null } = {}) {
  // With a loader registered, Windows entry specifiers must be relative to the plugin root:
  // raw `C:\` paths die on ERR_UNSUPPORTED_ESM_URL_SCHEME and file:// URLs get cwd-joined.
  // Hook probes therefore run from PLUGIN and take --config explicitly.
  const argv = hook
    ? ["--import", "./tests/module-hook.mjs", "./bin/ui-probe.mjs", ...args]
    : [BIN, ...args];
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  if (log) env.UI_PROBE_MODULE_LOG = log;
  try {
    const { stdout, stderr } = await execFile(process.execPath, argv, {
      cwd: hook ? PLUGIN : cwd,
      env,
      encoding: "utf8",
      timeout: 120000,
      maxBuffer: 16 * 1024 * 1024,
    });
    return { status: 0, stdout, stderr };
  } catch (e) {
    if (typeof e.code !== "number") throw e;
    return { status: e.code, stdout: e.stdout ?? "", stderr: e.stderr ?? "" };
  }
}

function scratchConfig(dir, config) {
  writeFileSync(path.join(dir, ".ui-probe.json"), JSON.stringify(config, null, 2));
}

function scratchDir(prefix) {
  return mkdtempSync(path.join(os.tmpdir(), `${prefix}-`));
}

test("run exits 0/1/2/3/64 and reports later steps not run", async () => {
  const fixture = await startFixtureServer();
  const dir = scratchDir("ui-probe-cli");
  const scenario = (name, lines) => {
    const file = path.join(dir, name);
    writeFileSync(file, lines.join("\n") + "\n");
    return file;
  };
  scratchConfig(dir, { baseUrl: fixture.origin });

  try {
    // 0: every step passed.
    const passing = scenario("passing.yaml", [
      "id: passing",
      "backend: http",
      "steps:",
      `  - expect_json: { url: "${fixture.path("/json/data")}", path: "ok", equals: true }`,
    ]);
    const ok = await probe(["run", passing], { cwd: dir });
    assert.equal(ok.status, 0, `a passing run exited ${ok.status}: ${ok.stderr}`);

    // 1: a failed step; the step after it never runs.
    const failing = scenario("failing.yaml", [
      "id: failing",
      "backend: http",
      "steps:",
      `  - expect_json: { url: "${fixture.path("/json/data")}", path: "ok", equals: false }`,
      `  - expect_json: { url: "${fixture.path("/json/data")}", path: "ok", equals: true }`,
    ]);
    const failed = await probe(["run", failing], { cwd: dir });
    assert.equal(failed.status, 1, `a failed step exited ${failed.status}: ${failed.stderr}`);
    assert.match(failed.stdout, /NOT_RUN/, "the step after the failure is reported as not run");

    // 3: nothing asserts, so a reader must judge — and no browser may launch.
    const idle = scenario("idle.yaml", [
      "id: idle",
      "backend: browser",
      "steps:",
      '  - open: { url: "http://example.invalid/" }',
    ]);
    const idleLog = path.join(dir, "idle.modules.log");
    const review = await probe(
      ["run", idle, "--config", path.join(dir, ".ui-probe.json")],
      { hook: true, log: idleLog },
    );
    assert.equal(review.status, 3, `a scenario without assertions exited ${review.status}: ${review.stderr}`);
    const idleModules = readFileSync(idleLog, "utf8");
    assert.ok(idleModules.includes("ui-probe.mjs"), "the module hook recorded the CLI entry");
    assert.ok(idleModules.includes("runner.mjs"), "the scenario still ran through the runner");
    assert.ok(!idleModules.includes("browser.mjs"), "needs_review must not launch a browser");

    // 64: an unknown op is an invalid scenario.
    const broken = scenario("broken.yaml", [
      "id: broken",
      "steps:",
      '  - frobnicate: { url: "/x" }',
    ]);
    const invalid = await probe(["run", broken], { cwd: dir });
    assert.equal(invalid.status, 64, `an invalid scenario exited ${invalid.status}: ${invalid.stderr}`);
    assert.match(invalid.stdout + invalid.stderr, /frobnicate/, "the unknown op is named");

    // 2: the endpoint refuses connections, so the probe cannot judge.
    await fixture.close();
    const unreachable = scenario("unreachable.yaml", [
      "id: unreachable",
      "backend: http",
      "steps:",
      `  - expect_json: { url: "${fixture.path("/json/data")}", path: "ok", equals: true }`,
    ]);
    const inconclusive = await probe(["run", unreachable], { cwd: dir });
    assert.equal(
      inconclusive.status,
      2,
      `a refused connection exited ${inconclusive.status}: ${inconclusive.stderr}`,
    );
  } finally {
    await fixture.close();
  }
});

test("screens and --help load none of browser, cdp, capture or runner", async () => {
  const dir = scratchDir("ui-probe-light");
  const configPath = path.join(dir, ".ui-probe.json");
  writeFileSync(configPath, JSON.stringify({
    baseUrl: "http://127.0.0.1:9",
    screens: {
      home: { url: "/", measure: ["[data-testid=action-tile]"] },
      detail: { url: "/media/603" },
    },
  }, null, 2));

  const screensLog = path.join(dir, "screens.modules.log");
  const screens = await probe(["screens", "--config", configPath], { hook: true, log: screensLog });
  assert.equal(screens.status, 0, `screens exited ${screens.status}: ${screens.stderr}`);
  assert.match(screens.stdout, /home/, "screens lists the screen name");
  assert.match(screens.stdout, /\/media\/603/, "screens lists the screen url");
  const screensModules = readFileSync(screensLog, "utf8");
  assert.ok(screensModules.includes("ui-probe.mjs"), "the module hook recorded the CLI entry");
  for (const name of HEAVY_MODULES) {
    assert.ok(!screensModules.includes(name), `screens must not load ${name}`);
  }

  const helpLog = path.join(dir, "help.modules.log");
  const help = await probe(["--help"], { hook: true, log: helpLog });
  assert.equal(help.status, 0, `--help exited ${help.status}: ${help.stderr}`);
  const helpModules = readFileSync(helpLog, "utf8");
  assert.ok(helpModules.includes("ui-probe.mjs"), "the module hook recorded the CLI entry");
  for (const name of HEAVY_MODULES) {
    assert.ok(!helpModules.includes(name), `--help must not load ${name}`);
  }
});

test("doctor names the first failing check and exits 0 when all pass", async () => {
  const fixture = await startFixtureServer();
  try {
    // Invalid config: the config check fails first.
    const badDir = scratchDir("ui-probe-doctor-config");
    writeFileSync(path.join(badDir, ".ui-probe.json"), "{}");
    const badConfig = await probe(["doctor"], { cwd: badDir });
    assert.notEqual(badConfig.status, 0, "doctor must fail on an invalid config");
    assert.match(badConfig.stdout + badConfig.stderr, /config/, "the failing check is named config");

    // Browser path points at a missing file: the browser check fails.
    const badBrowserDir = scratchDir("ui-probe-doctor-browser");
    scratchConfig(badBrowserDir, {
      baseUrl: fixture.origin,
      browser: path.join(badBrowserDir, "missing-browser.exe"),
    });
    const badBrowser = await probe(["doctor"], { cwd: badBrowserDir });
    assert.notEqual(badBrowser.status, 0, "doctor must fail when the browser is unfindable");
    assert.match(badBrowser.stdout + badBrowser.stderr, /browser/, "the failing check is named browser");

    // Config valid, a real browser launches, baseUrl answers: exit 0.
    let discoverable = true;
    try {
      findBrowser({});
    } catch {
      discoverable = false;
    }
    if (discoverable) {
      const goodDir = scratchDir("ui-probe-doctor-pass");
      scratchConfig(goodDir, { baseUrl: fixture.origin });
      const good = await probe(["doctor"], { cwd: goodDir });
      assert.equal(good.status, 0, `doctor should pass all checks: ${good.stdout}${good.stderr}`);
    } else {
      console.log("doctor pass case skipped: no Chromium browser found on this machine");
    }
  } finally {
    await fixture.close();
  }
});

test("capture prints the browser digest and exits 0", async (t) => {
  let browser;
  try {
    browser = findBrowser({});
  } catch (error) {
    if (process.env.UI_PROBE_REQUIRE_BROWSER === "1") throw error;
    t.skip(`no Chromium browser found: ${error.message}`);
    return;
  }

  const fixture = await startFixtureServer();
  const dir = scratchDir("ui-probe-capture-cli");
  const outDir = path.join(dir, "out");
  scratchConfig(dir, {
    baseUrl: fixture.origin,
    browser,
    viewports: { desktop: { width: 800, height: 600 } },
    screens: {
      tiles: { url: "/tiles-good.html", measure: ["[data-testid=action-tile]"] },
    },
  });

  try {
    const result = await probe(["capture", "tiles", "--viewport", "desktop", "--out", outDir], { cwd: dir });
    assert.equal(result.status, 0, `capture exited ${result.status}: ${result.stderr}`);
    assert.match(result.stdout, /desktop 800×600 hover:(none|hover) pointer:(coarse|fine)/);
    assert.match(result.stdout, /\[data-testid=action-tile\] widths=111,111,111/);
    assert.match(result.stdout, /blocked: \d+/);
    assert.match(result.stdout, /out:/);
  } finally {
    await fixture.close();
  }
});

test("capture exits 64 and prints AuthError when a cookie variable is missing", async () => {
  const fixture = await startFixtureServer();
  const dir = scratchDir("ui-probe-capture-auth");
  scratchConfig(dir, {
    baseUrl: fixture.origin,
    screens: { tiles: { url: "/tiles-good.html" } },
    auth: { cookies: [{ name: "session", command: ["echo", "{missing}"] }] },
  });

  try {
    const result = await probe(["capture", "tiles", "--viewport", "phone"], { cwd: dir });
    assert.equal(result.status, 64, `capture exited ${result.status}: ${result.stderr}`);
    assert.match(result.stderr, /auth cookie "session".*variable "missing" is not set/);
  } finally {
    await fixture.close();
  }
});

test("run resolves auth cookies before it launches a browser, so a missing --var exits 64", async () => {
  const dir = scratchDir("ui-probe-run-auth");
  scratchConfig(dir, {
    baseUrl: "http://127.0.0.1:9",
    // A launch attempt would fail here with exit 2, so exit 64 proves no browser started.
    browser: path.join(dir, "missing-browser.exe"),
    auth: { cookies: [{ name: "session", command: ["echo", "{missing}"] }] },
  });
  const scenario = path.join(dir, "signed-in.yaml");
  writeFileSync(scenario, [
    "id: signed-in",
    "steps:",
    '  - open: { url: "/" }',
    '  - expect_text: { target: "#who", equals: "signed in" }',
    "",
  ].join("\n"));

  const result = await probe(["run", scenario, "--out", path.join(dir, "out")], { cwd: dir });
  assert.equal(result.status, 64, `run exited ${result.status}: ${result.stderr}`);
  assert.match(result.stderr, /auth cookie "session".*variable "missing" is not set/, result.stderr);
  assert.doesNotMatch(result.stdout, /^run:/m, "no digest may print: the run never started");
  assert.equal(existsSync(path.join(dir, "out", "results.json")), false, "no run may be recorded");
});
