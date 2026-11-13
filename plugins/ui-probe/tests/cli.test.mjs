// CLI rows: run exit codes, lazy module loading, doctor's named checks. Every invocation is a
// real child process so the exit code and the loaded-module set are the ones a user gets.

import test from "node:test";
import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
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
async function probe(args, { cwd = PLUGIN, hook = false, log = null, env: overrides = null } = {}) {
  // With a loader registered, Windows entry specifiers must be relative to the plugin root:
  // raw `C:\` paths die on ERR_UNSUPPORTED_ESM_URL_SCHEME and file:// URLs get cwd-joined.
  // Hook probes therefore run from PLUGIN and take --config explicitly.
  const argv = hook
    ? ["--import", "./tests/module-hook.mjs", "./bin/ui-probe.mjs", ...args]
    : [BIN, ...args];
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  // A null override deletes the variable: that is how a test hides sdb from findSdb.
  for (const [name, value] of Object.entries(overrides ?? {})) {
    if (value === null) delete env[name];
    else env[name] = value;
  }
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
      /^FAILED broken:1 expect_widths \[data-testid=action-tile\] measured=\[111,111,111\] expected=54$/m,
      result.stdout,
    );
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

// -- the TV branches --------------------------------------------------------

// sdb must not exist for any TV CLI test: an empty PATH and an empty home leave findSdb with
// nothing to find, so no real sdb can ever be spawned. The TV paths reached here never want it.
function noSdbEnv(home) {
  return { PATH: null, USERPROFILE: home, HOME: home, TEMP: home, TMP: home };
}

// A CDP target the CLI can attach to with --attach-port: /json/list, /json/protocol and a
// WebSocket that answers CDP calls. Only reachable over loopback, never the set.
async function startCdpStub({ protocol, evaluate = () => null } = {}) {
  const sockets = new Set();
  const server = createServer((req, res) => {
    const json = (body) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    if (req.url === "/json/list") {
      const { port } = server.address();
      return json([{ id: "p1", type: "page", webSocketDebuggerUrl: `ws://127.0.0.1:${port}/devtools/page/p1` }]);
    }
    if (req.url === "/json/protocol") return json(protocol ?? { domains: [] });
    res.writeHead(404);
    res.end();
  });

  server.on("upgrade", (req, socket) => {
    const accept = createHash("sha1")
      .update(`${req.headers["sec-websocket-key"]}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
      .digest("base64");
    socket.write([
      "HTTP/1.1 101 Switching Protocols",
      "Upgrade: websocket",
      "Connection: Upgrade",
      `Sec-WebSocket-Accept: ${accept}`,
      "",
      "",
    ].join("\r\n"));
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    let pending = Buffer.alloc(0);
    socket.on("data", (chunk) => {
      pending = Buffer.concat([pending, chunk]);
      for (;;) {
        const frame = readFrame(pending);
        if (!frame) return;
        pending = frame.rest;
        if (frame.opcode === 0x8) { socket.end(); return; }
        if (frame.opcode !== 0x1) continue;
        const message = JSON.parse(frame.text);
        if (message.id == null) continue;
        const value = message.method === "Runtime.evaluate"
          ? { result: { result: { value: evaluate(message.params?.expression ?? "") } } }
          : { result: {} };
        socket.write(encodeFrame(JSON.stringify({ id: message.id, ...value })));
      }
    });
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    port: server.address().port,
    close: () => new Promise((resolve) => {
      for (const socket of sockets) socket.destroy();
      server.closeAllConnections?.();
      server.close(resolve);
    }),
  };
}

function readFrame(buffer) {
  if (buffer.length < 2) return null;
  const opcode = buffer[0] & 0x0f;
  const masked = (buffer[1] & 0x80) !== 0;
  let length = buffer[1] & 0x7f;
  let offset = 2;
  if (length === 126) {
    if (buffer.length < 4) return null;
    length = buffer.readUInt16BE(2);
    offset = 4;
  } else if (length === 127) {
    if (buffer.length < 10) return null;
    length = Number(buffer.readBigUInt64BE(2));
    offset = 10;
  }
  const maskAt = offset;
  if (masked) offset += 4;
  if (buffer.length < offset + length) return null;
  const payload = Buffer.from(buffer.subarray(offset, offset + length));
  if (masked) {
    const mask = buffer.subarray(maskAt, maskAt + 4);
    for (let i = 0; i < payload.length; i += 1) payload[i] ^= mask[i % 4];
  }
  return { opcode, text: payload.toString("utf8"), rest: buffer.subarray(offset + length) };
}

function encodeFrame(text) {
  const payload = Buffer.from(text, "utf8");
  let header;
  if (payload.length < 126) {
    header = Buffer.from([0x81, payload.length]);
  } else if (payload.length < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x81;
    header[1] = 126;
    header.writeUInt16BE(payload.length, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x81;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(payload.length), 2);
  }
  return Buffer.concat([header, payload]);
}

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

test("row 1: doctor checks the tv block, or reports the tv checks skipped without one", async (t) => {
  // No sdb can be found: no PATH, an empty home, so neither PATH nor the SDK layouts answer.
  const dir = scratchDir("ui-probe-doctor-tv");
  const home = scratchDir("ui-probe-doctor-tv-home");
  scratchConfig(dir, {
    baseUrl: "http://127.0.0.1:9",
    tv: { host: "192.0.2.10:26101", appid: "torrenthub.main" },
  });

  const missing = await probe(["doctor"], { cwd: dir, env: noSdbEnv(home) });
  assert.notEqual(missing.status, 0, "doctor must fail when the tv block has no sdb");
  assert.match(missing.stdout + missing.stderr, /tv\.sdb/, "the failing check is named tv.sdb");

  // A config with no tv block: the tv checks are skipped, and the rest still decides the exit.
  let browser;
  try {
    browser = findBrowser({});
  } catch (error) {
    if (process.env.UI_PROBE_REQUIRE_BROWSER === "1") throw error;
    t.skip(`no Chromium browser found: ${error.message}`);
    return;
  }

  const fixture = await startFixtureServer();
  const webDir = scratchDir("ui-probe-doctor-notv");
  scratchConfig(webDir, { baseUrl: fixture.origin, browser });
  try {
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

  // Row 6: --allow-writes with no tv.testOrigin, refused before any attach is attempted.
  scratchConfig(dir, { baseUrl: "http://127.0.0.1:9", tv: base });
  const noOrigin = await probe(["run", scenario, "--device", "tv", "--allow-writes"], { cwd: dir, env });
  assert.equal(noOrigin.status, 64, `exited ${noOrigin.status}: ${noOrigin.stderr}`);
  assert.match(noOrigin.stderr, /tv\.testOrigin/, noOrigin.stderr);

  // Row 7: a target with neither Fetch nor Network interception.
  const stub = await startCdpStub({ protocol: { domains: [{ domain: "Page", commands: [{ name: "navigate" }] }] } });
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

  const features = {
    userAgent: "stub",
    tizen: "undefined",
    tvinputdevice: "undefined",
    application: "undefined",
    webapis: "undefined",
    IntersectionObserver: false,
    ResizeObserver: false,
    registerKeyPresent: false,
    currentAppPresent: false,
    flexGap: true,
    aspectRatio: true,
    backdropFilter: false,
  };
  const stub = await startCdpStub({
    protocol: { domains: [{ domain: "Page" }, { domain: "Network" }] },
    evaluate: (expression) => {
      const js = String(expression);
      if (js.includes("IntersectionObserver")) return features;
      if (js.includes("__uiProbeKey.read")) return [];
      if (js.includes("__uiProbeKey = {")) return { active: "BODY" };
      if (js.includes("data-ui-probe-focus")) return true;
      return null;
    },
  });

  try {
    const result = await probe(
      ["tv", "probe", "--attach-port", String(stub.port), "--out", outDir],
      { cwd: dir, env },
    );
    assert.equal(result.status, 0, `tv probe exited ${result.status}: ${result.stderr}`);

    const written = JSON.parse(readFileSync(path.join(outDir, "platform.json"), "utf8"));
    assert.equal(written.schema, "ui-probe-platform@1");
    const cached = path.join(home, "ui-probe", `platform-${appid}.json`);
    assert.equal(JSON.parse(readFileSync(cached, "utf8")).verdict, written.verdict, "capture reads this copy");

    const lines = result.stdout.trimEnd().split("\n");
    assert.match(lines.at(-1), /^shell: /, `the digest ends on the verdict line: ${lines.at(-1)}`);
    assert.match(result.stdout, /^out: /m, "the digest names its output directory");
  } finally {
    await stub.close();
  }
});
