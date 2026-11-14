// The `tv probe` branch of the CLI: what it prints, what it writes, and the flags that change it.
// Every invocation is a real child process, so the exit code is the one a user gets.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  noSdbEnv, probe, scratchConfig, scratchDir, startCdpStub, startGuidedListenStub, SETTLED_PAGE, TV_FEATURES,
} from "./cli-support.mjs";

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
