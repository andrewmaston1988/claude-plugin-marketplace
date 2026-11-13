// TV CLI rows: the tv branches of run and capture, `tv probe`, and doctor's TV checks. Every
// invocation is a real child process, so the exit code is the one a user gets.

import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { startFixtureServer } from "./fixtures/server.mjs";
import { findBrowser } from "../src/browser.mjs";
import { probe, scratchConfig, scratchDir } from "./cli-support.mjs";

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

  // Row 6: --allow-writes with no tv.testOrigin, refused before any attach is attempted.
  scratchConfig(dir, { baseUrl: "http://127.0.0.1:9", tv: base });
  const noOrigin = await probe(["run", scenario, "--device", "tv", "--allow-writes"], { cwd: dir, env });
  assert.equal(noOrigin.status, 64, `exited ${noOrigin.status}: ${noOrigin.stderr}`);
  assert.match(noOrigin.stderr, /tv\.testOrigin/, noOrigin.stderr);

  // Row 7: a target with neither Fetch nor Network interception.
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

// Row 7: the pre-flight must judge the steps the include brings in, not only the file's own.
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

// Row 6: the device decides the scope, whatever the file declares.
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

// Row 22: the attach cost is the first thing a TV run's digest says.
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
    assert.match(header, /^tv attach: \d+ ms, relaunch: n\/a$/, `the header: ${header}`);
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
      if (js.includes("document.readyState")) return SETTLED_PAGE;
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
    assert.equal(typeof written.timings.attachMs, "number", "the attach cost is recorded");
    assert.equal(written.timings.relaunchMs, null, "a join has no relaunch to time");
    const cached = path.join(home, "ui-probe", `platform-${appid}.json`);
    assert.equal(JSON.parse(readFileSync(cached, "utf8")).verdict, written.verdict, "capture reads this copy");

    const lines = result.stdout.trimEnd().split("\n");
    assert.match(lines.at(-1), /^shell: /, `the digest ends on the verdict line: ${lines.at(-1)}`);
    assert.match(result.stdout, /^out: /m, "the digest names its output directory");
  } finally {
    await stub.close();
  }
});

// Row 7: a target that will not serve /json/protocol offers no interception. Null is only a
// modern browser on the web path, where the protocol is never requested.
test("row 7: an unreadable protocol on the TV counts as no interception", async () => {
  const { tvSession } = await import("../src/tv/cli.mjs");
  const attachTo = (protocol) => async () => ({ cdp: {}, port: 43411, protocol, detach: async () => {} });
  const config = { tv: { host: "192.0.2.10:26101", appid: "torrenthub.main" } };

  assert.equal((await tvSession(config, { _attach: attachTo(null) })).intercepted, false);
  assert.equal((await tvSession(config, {
    _attach: attachTo({ domains: [{ domain: "Network", commands: [{ name: "setRequestInterception" }] }] }),
  })).intercepted, true);
});
