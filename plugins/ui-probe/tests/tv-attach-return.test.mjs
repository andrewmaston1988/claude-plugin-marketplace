// Rows 8-10 and 15: the attach's launch-path return. Detection reads the screen before the
// widget closes; the restore runs after detach's kill and forward removal; a join and an
// opted-out run touch REST at all. One log spans the sdb and fetch stubs, so order is the
// assertion rather than an artefact of two separate call lists.

import { test } from "node:test";
import assert from "node:assert/strict";
import { attach, AttachInconclusive } from "../src/tv/attach.mjs";

const HOST = "192.0.2.10:26101";
const APPID = "torrenthub.shell";
const PKGID = "torrenthub";
const PORT = 43411;
const APPLE_TV = "3201807016597";
const APPLIST = "PkgId Ver Name\n'Torrent Test'\t '1.0'\t 'torrenthub.shell'\n";
const SETTLED = { href: "http://192.0.2.30:8000/tv", origin: "http://192.0.2.30:8000", ready: "complete", hasBody: true };
const CONFIG = { tv: { host: HOST, appid: APPID, returnApps: [APPLE_TV] } };

const ok = (stdout = "") => ({ code: 0, stdout, stderr: "" });
const body = (value, status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  text: async () => JSON.stringify(value),
  json: async () => value,
});
const showing = () => body({ id: APPLE_TV, name: "Apple TV", running: true, visible: true });
const hidden = () => body({ id: APPLE_TV, name: "Apple TV", running: true, visible: false });

/** The sdb answers a launching attach asks for, recorded into `log` with the fetch calls. */
function sdbStub(log, { debug = ok(`launched port: ${PORT}`), kill = ok("Terminated") } = {}) {
  return async (argv) => {
    const text = argv.join(" ");
    log.push(`sdb ${text}`);
    if (text === "devices") return ok(`${HOST} \tdevice \tUE50TV\n`);
    if (text === "shell 0 applist") return ok(APPLIST);
    if (text === `shell 0 kill ${PKGID}`) return kill;
    if (text === `shell 0 debug ${APPID}`) return debug;
    return ok();
  };
}

/**
 * The inspector and REST answers, in one log. The REST GETs are read by phase: the first is
 * detection (before the close), the second the restore's re-read, and everything after the POST
 * is a poll. A phase that is absent throws, so a call the test did not expect is loud.
 */
function fetchStub(log, { detection = showing, reread = hidden, post = showing, polls = [showing()] } = {}) {
  let gets = 0;
  let launched = false;
  let poll = 0;
  return async (url, options = {}) => {
    const { pathname } = new URL(url);
    const method = options.method ?? "GET";
    log.push(`fetch ${method} ${pathname}`);
    if (pathname === "/json/list") {
      return body([{ type: "page", webSocketDebuggerUrl: `ws://127.0.0.1:${PORT}/devtools/page/1` }]);
    }
    if (pathname === "/json/protocol") return body({ domains: [{ domain: "Network" }] });
    if (method === "POST") {
      launched = true;
      return post();
    }
    if (!launched) {
      const phase = gets++ === 0 ? detection : reread;
      if (!phase) throw new Error(`unexpected REST GET ${pathname} before the POST`);
      return phase();
    }
    if (!polls.length) throw new Error(`unexpected poll ${pathname}`);
    return polls[Math.min(poll++, polls.length - 1)];
  };
}

const base = (log, overrides = {}) => ({
  returnToApp: true,
  _sdb: sdbStub(log),
  _fetch: fetchStub(log),
  _connect: async () => ({ close() {} }),
  _evaluate: async () => SETTLED,
  _sleep: async () => {},
  settleHoldMs: 0,
  ...overrides,
});

const indexes = (log, text) => log.flatMap((entry, index) => (entry === text ? [index] : []));
const restGets = (log) => log.filter((entry) => entry.startsWith("fetch GET /api/v2/applications/")).length;
const posts = (log) => log.filter((entry) => entry.startsWith("fetch POST ")).length;

test("row 8: detection reads before the widget closes, and the relaunch posts after the kill and forward removal", async () => {
  const log = [];
  const attached = await attach(CONFIG, base(log));

  const record = await attached.detach();

  assert.deepEqual(record, { id: APPLE_TV, name: "Apple TV", outcome: "returned" });
  const detection = log.indexOf(`fetch GET /api/v2/applications/${APPLE_TV}`);
  const kills = indexes(log, `sdb shell 0 kill ${PKGID}`);
  const debug = log.indexOf(`sdb shell 0 debug ${APPID}`);
  const forward = log.indexOf(`sdb forward --remove tcp:${PORT}`);
  const post = log.findIndex((entry) => entry.startsWith("fetch POST "));

  assert.equal(kills.length, 2, "the close, then the detach's kill");
  assert.ok(detection >= 0, "detection made its GET");
  assert.ok(detection < kills[0], "detection reads before the first kill");
  assert.ok(detection < debug, "and before the widget launches");
  assert.ok(post > kills[1], "the relaunch follows the detach's kill");
  assert.ok(post > forward, "and the forward removal");
});

test("row 9: the error path after a real launch returns the app and keeps the original error", async () => {
  const log = [];
  let polls = 0;
  const attached = attach(CONFIG, base(log, {
    _evaluate: async () => {
      polls += 1;
      return { href: `http://127.0.0.1/loading-${polls}.html`, origin: "http://127.0.0.1", ready: "loading", hasBody: true };
    },
    settleTimeoutMs: 250,
    settlePollMs: 250,
  }));

  await assert.rejects(attached, (error) => {
    assert.ok(error instanceof AttachInconclusive, `the attach's own error: ${error}`);
    assert.match(error.message, /did not settle/);
    assert.deepEqual(error.tvReturn, { id: APPLE_TV, name: "Apple TV", outcome: "returned" });
    return true;
  });
  assert.equal(posts(log), 1, "the app was put back");
  assert.ok(
    log.findIndex((entry) => entry.startsWith("fetch POST ")) > indexes(log, `sdb shell 0 kill ${PKGID}`).at(-1),
    "and only after the widget was killed",
  );
});

test("row 9: a restore that throws does not replace the original error", async () => {
  const log = [];
  let sleeps = 0;
  const attached = attach(CONFIG, base(log, {
    _evaluate: async () => ({ href: "http://127.0.0.1/loading.html", origin: "http://127.0.0.1", ready: "loading", hasBody: true }),
    settleTimeoutMs: 250,
    settlePollMs: 250,
    // The first two sleeps belong to the settle wait; the third is the restore's first poll.
    _sleep: async () => { sleeps += 1; if (sleeps === 3) throw new Error("the poll's sleep broke"); },
    _fetch: fetchStub(log, { polls: [hidden()] }),
  }));

  await assert.rejects(attached, (error) => {
    assert.ok(error instanceof AttachInconclusive, `the attach's own error: ${error}`);
    assert.match(error.message, /did not settle/, "the restore's failure is not the one rethrown");
    assert.equal(error.tvReturn.id, APPLE_TV);
    assert.match(error.tvReturn.outcome, /^failed: the return did not report$/);
    return true;
  });
});

test("row 9: an inconclusive launch and a failed closeApp make zero POSTs", async () => {
  const noPort = [];
  await assert.rejects(
    attach(CONFIG, base(noPort, { _sdb: sdbStub(noPort, { debug: ok("") }) })),
    AttachInconclusive,
  );
  assert.equal(posts(noPort), 0, "the widget may be up, so nothing is posted over it");
  assert.equal(restGets(noPort), 1, "the screen was still read");

  const closeFailed = [];
  await assert.rejects(
    attach(CONFIG, base(closeFailed, {
      _sdb: sdbStub(closeFailed, { kill: { code: 1, stdout: "failed", stderr: "" } }),
    })),
    AttachInconclusive,
  );
  assert.equal(posts(closeFailed), 0, "nothing was displaced, so nothing is relaunched");
});

test("row 10: a join makes no REST call and detach resolves to null", async () => {
  const log = [];
  const session = await attach(CONFIG, base(log, {
    attachPort: PORT,
    _sdb: async (argv) => { log.push(`sdb ${argv.join(" ")}`); return ok(); },
  }));

  assert.equal(restGets(log), 0, "a join launched over nothing");
  assert.equal(await session.detach(), null, "so there is no record and no line");
  assert.equal(restGets(log), 0);
  assert.equal(posts(log), 0);
});

test("row 10: returnToApp false makes no REST call and resolves to off", async () => {
  const log = [];
  const attached = await attach(CONFIG, base(log, { returnToApp: false }));

  assert.equal(restGets(log), 0, "detection is skipped entirely when the return is off");
  assert.deepEqual(await attached.detach(), { outcome: "off" });
  assert.equal(posts(log), 0);
});

test("row 15: detach is memoised, so every path shares one kill, forward removal and restore", async () => {
  const log = [];
  const attached = await attach(CONFIG, base(log));

  const [first, second] = await Promise.all([attached.detach(), attached.detach()]);
  await attached.detach();

  assert.equal(posts(log), 1, "one restore, not one per caller");
  assert.equal(first, second, "the same record comes back every time");
  assert.deepEqual(first, { id: APPLE_TV, name: "Apple TV", outcome: "returned" });
  assert.equal(indexes(log, `sdb shell 0 kill ${PKGID}`).length, 2, "one close and one detach kill");
});

test("row 6: nothing visible after the launch still reports and posts nothing", async () => {
  const log = [];
  const attached = await attach(CONFIG, base(log, {
    _fetch: fetchStub(log, { detection: hidden, reread: hidden }),
  }));

  assert.deepEqual(await attached.detach(), { outcome: "nothing was showing" });
  assert.equal(posts(log), 0);
});
