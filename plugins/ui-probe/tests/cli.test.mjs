// CLI rows: run exit codes, lazy module loading, doctor's named checks. Every invocation is a
// real child process so the exit code and the loaded-module set are the ones a user gets.

import test from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { startFixtureServer } from "./fixtures/server.mjs";
import { findBrowser } from "../src/browser.mjs";
import { probe, scratchConfig, scratchDir } from "./cli-support.mjs";

const HEAVY_MODULES = ["browser.mjs", "cdp.mjs", "capture.mjs", "runner.mjs"];

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

test("row 28: a capture whose screen step fails prints that step's digest line", async (t) => {
  let browser;
  try {
    browser = findBrowser({});
  } catch (error) {
    if (process.env.UI_PROBE_REQUIRE_BROWSER === "1") throw error;
    t.skip(`no Chromium browser found: ${error.message}`);
    return;
  }

  const fixture = await startFixtureServer();
  const dir = scratchDir("ui-probe-capture-failure");
  const outDir = path.join(dir, "out");
  scratchConfig(dir, {
    baseUrl: fixture.origin,
    browser,
    viewports: { desktop: { width: 800, height: 600 } },
    screens: {
      broken: {
        url: "/tiles-good.html",
        steps: [{ expect_widths: { target: "[data-testid=action-tile]", equals: 54, timeoutMs: 0 } }],
      },
    },
  });

  try {
    const result = await probe(["capture", "broken", "--viewport", "desktop", "--out", outDir], { cwd: dir });
    assert.match(result.stdout, /^steps: failed$/m, result.stdout);
    assert.match(
      result.stdout,
      /^FAILED broken#step1 expect_widths \[data-testid=action-tile\] measured=\[111,111,111\] expected=54$/m,
      result.stdout,
    );
  } finally {
    await fixture.close();
  }
});

test("row 8: a browser run writes console.json and network.json beside results.json", async (t) => {
  let browser;
  try {
    browser = findBrowser({});
  } catch (error) {
    if (process.env.UI_PROBE_REQUIRE_BROWSER === "1") throw error;
    t.skip(`no Chromium browser found: ${error.message}`);
    return;
  }

  const fixture = await startFixtureServer();
  const dir = scratchDir("ui-probe-run-evidence");
  const scenario = (name, assertion) => {
    const file = path.join(dir, name);
    writeFileSync(file, [
      "id: console-evidence",
      "backend: browser",
      "steps:",
      `  - open: { url: "${fixture.path("/console.html")}" }`,
      `  - expect_text: { target: "#ready", ${assertion} }`,
      "",
    ].join("\n"));
    return file;
  };
  const readJson = (file) => JSON.parse(readFileSync(file, "utf8"));
  const evidenceFiles = (out) => ["console.json", "network.json"].map((name) => path.join(out, name));

  try {
    scratchConfig(dir, { baseUrl: fixture.origin, browser });

    // Passing: the page's own log, its error, and both requests it made.
    const passingOut = path.join(dir, "passing-out");
    const passing = await probe(["run", scenario("passing.yaml", 'equals: "ready"'), "--out", passingOut], { cwd: dir });
    assert.equal(passing.status, 0, `a passing run exited ${passing.status}: ${passing.stderr}`);
    for (const file of [path.join(passingOut, "results.json"), ...evidenceFiles(passingOut)]) {
      assert.equal(existsSync(file), true, `${path.basename(file)} is written`);
    }
    const consoleLog = readJson(path.join(passingOut, "console.json"));
    assert.ok(consoleLog.some((entry) => entry.level === "log" && entry.text === "hello from the page"), JSON.stringify(consoleLog));
    assert.ok(consoleLog.some((entry) => entry.level === "error" && entry.text === "boom"), JSON.stringify(consoleLog));
    const network = readJson(path.join(passingOut, "network.json"));
    assert.ok(network.some((entry) => entry.url === fixture.path("/console.html") && entry.status === 200), JSON.stringify(network));
    assert.ok(network.some((entry) => entry.url === fixture.path("/json/data") && entry.status === 200), JSON.stringify(network));

    // Failing: the evidence is exactly what a failing journey is diagnosed from, so it must exist.
    const failingOut = path.join(dir, "failing-out");
    const failing = await probe(
      ["run", scenario("failing.yaml", 'equals: "never", timeoutMs: 0'), "--out", failingOut],
      { cwd: dir },
    );
    assert.equal(failing.status, 1, `a failing run exited ${failing.status}: ${failing.stderr}`);
    for (const file of evidenceFiles(failingOut)) {
      assert.equal(existsSync(file), true, `${path.basename(file)} is written for a failing run`);
    }

    // No page to record: an http run writes neither.
    const httpOut = path.join(dir, "http-out");
    const httpScenario = path.join(dir, "http.yaml");
    writeFileSync(httpScenario, [
      "id: http-evidence",
      "backend: http",
      "steps:",
      `  - expect_json: { url: "${fixture.path("/json/data")}", path: "ok", equals: true }`,
      "",
    ].join("\n"));
    const http = await probe(["run", httpScenario, "--out", httpOut], { cwd: dir });
    assert.equal(http.status, 0, `an http run exited ${http.status}: ${http.stderr}`);
    for (const file of evidenceFiles(httpOut)) {
      assert.equal(existsSync(file), false, `${path.basename(file)} must not be written by an http run`);
    }

    // Nothing launched: an invalid run writes neither.
    const invalidOut = path.join(dir, "invalid-out");
    const invalidScenario = path.join(dir, "invalid.yaml");
    writeFileSync(invalidScenario, ["id: invalid-evidence", "steps:", '  - frobnicate: { url: "/x" }', ""].join("\n"));
    const invalid = await probe(["run", invalidScenario, "--out", invalidOut], { cwd: dir });
    assert.equal(invalid.status, 64, `an invalid run exited ${invalid.status}: ${invalid.stderr}`);
    for (const file of evidenceFiles(invalidOut)) {
      assert.equal(existsSync(file), false, `${path.basename(file)} must not be written by an invalid run`);
    }
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

