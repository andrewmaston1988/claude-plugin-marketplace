// Row 11, row 12's line and row 15: the CLI's TV call sites driven through tvSession's
// `_attach` seam with a fake session. The command's final lines are assembled by
// tvCommandLines here, and the bin prints what that returns.

import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  captureOnTv, restoreEnabled, runOnTv, runTvBranch, tvCommandLines, tvFailureOutput,
  tvReturnLine, tvSession, writeTvReturn,
} from "../src/tv/cli.mjs";

const CONFIG = { tv: { host: "192.0.2.10:26101", appid: "torrenthub.main" }, outDir: path.join(os.tmpdir(), "ui-probe-tv-return-out") };
const DOC = { id: "return", backend: "tv", steps: [] };
const RECORD = { id: "3201807016597", name: "Apple TV", outcome: "returned" };
const PASSED = { outcome: "passed", exitCode: 0, steps: [], problems: [] };
const OFF = { outcome: "off" };

/** A fake attach that records the options it was handed and returns the record it is given. */
function fakeAttach({ seen = [], record = null } = {}) {
  const attachFn = async (config, options) => {
    seen.push(options);
    const answer = record ?? (options.returnToApp ? RECORD : OFF);
    return {
      cdp: {},
      port: 43411,
      // A target with Fetch, so the write policy has interception and no --allow-writes is owed.
      protocol: { domains: [{ domain: "Fetch" }] },
      timings: { attachMs: 5, relaunchMs: 40, settleMs: 10 },
      detach: async () => answer,
    };
  };
  return attachFn;
}

const until = async (done) => {
  for (let i = 0; i < 200 && !done(); i += 1) await new Promise((resolve) => setTimeout(resolve, 1));
};

test("row 11: a run and a capture carry their tv record out of the call site", async () => {
  const runSeen = [];
  const run = await runOnTv({
    doc: DOC,
    config: CONFIG,
    _attach: fakeAttach({ seen: runSeen }),
    _run: async () => PASSED,
  });
  assert.deepEqual(run.tvReturn, RECORD);
  assert.equal(run.result.outcome, "passed");
  assert.equal(runSeen[0].returnToApp, true, "the config's policy reaches attach");

  const captureSeen = [];
  const capture = await captureOnTv({
    screen: { url: "/tv" },
    config: CONFIG,
    _attach: fakeAttach({ seen: captureSeen }),
    _capture: async () => ({ digest: "capture digest", outDir: CONFIG.outDir }),
  });
  assert.deepEqual(capture.tvReturn, RECORD);
  assert.equal(capture.digest, "capture digest");
  assert.equal(captureSeen[0].returnToApp, true);
});

test("row 11: a run that throws keeps its own error and rides the record on it", async () => {
  const boom = new Error("the journey broke");
  await assert.rejects(
    runOnTv({ doc: DOC, config: CONFIG, _attach: fakeAttach(), _run: async () => { throw boom; } }),
    (error) => {
      assert.equal(error, boom, "the journey's own error is the one that escapes");
      assert.deepEqual(error.tvReturn, RECORD);
      return true;
    },
  );

  const failingCapture = new Error("the capture broke");
  await assert.rejects(
    captureOnTv({
      screen: { url: "/tv" },
      config: CONFIG,
      _attach: fakeAttach(),
      _capture: async () => { throw failingCapture; },
    }),
    (error) => {
      assert.equal(error, failingCapture);
      assert.deepEqual(error.tvReturn, RECORD);
      return true;
    },
  );
});

test("row 11: a failed return never changes a passed run's exit code", async () => {
  const done = await runTvBranch({
    doc: DOC,
    config: CONFIG,
    rest: [],
    getFlag: () => null,
    _attach: fakeAttach({ record: { id: RECORD.id, name: RECORD.name, outcome: "failed: POST answered an empty body" } }),
    _run: async () => PASSED,
  });

  assert.equal(done.exitCode, 0, "the verdict is about the app under test");
  assert.equal(done.result.outcome, "passed");
  assert.match(done.tvReturn.outcome, /^failed: /);
  assert.equal(
    tvReturnLine(done.tvReturn),
    "tv return: Apple TV (3201807016597) — failed: POST answered an empty body",
  );
});

test("row 11: the record is written beside the other output; a joined session writes nothing", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "ui-probe-tv-return-write-"));
  writeTvReturn(dir, RECORD);
  assert.deepEqual(JSON.parse(readFileSync(path.join(dir, "tv-return.json"), "utf8")), RECORD);

  const joined = mkdtempSync(path.join(os.tmpdir(), "ui-probe-tv-return-join-"));
  writeTvReturn(joined, null);
  assert.equal(existsSync(path.join(joined, "tv-return.json")), false, "a join has no record");
});

test("row 12: --stay and tv.returnToApp false turn the return off, and the line says so", async () => {
  assert.equal(restoreEnabled(CONFIG), true);
  assert.equal(restoreEnabled(CONFIG, true), false, "--stay wins");
  assert.equal(restoreEnabled({ tv: { returnToApp: false } }), false);
  assert.equal(restoreEnabled({ tv: { returnToApp: true } }, true), false);

  const seen = [];
  const result = await runOnTv({
    doc: DOC,
    config: CONFIG,
    stay: true,
    _attach: fakeAttach({ seen }),
    _run: async () => PASSED,
  });
  assert.equal(seen[0].returnToApp, false, "the attach is told there is nothing to put back");
  assert.deepEqual(result.tvReturn, OFF);
  assert.equal(tvReturnLine(result.tvReturn), "tv return: off");
});

test("row 12: tv.returnToApp false reaches attach as false", async () => {
  const seen = [];
  await runOnTv({
    doc: DOC,
    config: { ...CONFIG, tv: { ...CONFIG.tv, returnToApp: false } },
    _attach: fakeAttach({ seen }),
    _run: async () => PASSED,
  });
  assert.equal(seen[0].returnToApp, false);
});

test("row 11: a capture's record is written where its artefacts are, under <out>/tv", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "ui-probe-tv-capture-dir-"));
  const config = { ...CONFIG, outDir: dir };
  const capture = await captureOnTv({
    screen: { url: "/tv" },
    config,
    _attach: fakeAttach(),
    _capture: async (screen, ctx) => ({ digest: "capture digest", outDir: ctx.outDir ?? dir }),
  });

  assert.equal(capture.outDir, path.join(dir, "tv"), "the digest's out: line names <out>/tv");
  writeTvReturn(capture.outDir, capture.tvReturn);
  assert.deepEqual(
    JSON.parse(readFileSync(path.join(dir, "tv", "tv-return.json"), "utf8")),
    RECORD,
    "the record lands beside dom.html and env.json, not in the run root",
  );
});

test("row 11: a command that throws ends on the return line and still writes the record", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "ui-probe-tv-throw-"));
  const error = new Error("the journey broke");
  error.tvReturn = RECORD;

  const lines = tvFailureOutput(dir, error);

  assert.equal(lines.at(-1), "tv return: Apple TV (3201807016597) — returned");
  assert.deepEqual(JSON.parse(readFileSync(path.join(dir, "tv-return.json"), "utf8")), RECORD);
  assert.deepEqual(tvFailureOutput(dir, new Error("no record")), [], "a non-TV failure writes nothing");
});

test("row 11: the command's last line is the return line, whatever the command printed", () => {
  const said = [
    "PASSED open /tv",
    "run: passed (1 passed, 0 failed, 0 inconclusive, 0 not run) → out",
  ];

  assert.deepEqual(
    tvCommandLines(said, RECORD),
    [...said, "tv return: Apple TV (3201807016597) — returned"],
    "the digest keeps its order and the return is appended",
  );
  assert.equal(
    tvCommandLines("capture digest", RECORD).at(-1),
    "tv return: Apple TV (3201807016597) — returned",
    "a capture's multi-line digest is one block, with the line after it",
  );
  assert.deepEqual(tvCommandLines(said, null), said, "a joined session adds no line");
  assert.deepEqual(tvCommandLines(said, undefined), said);
});

test("row 15: a signal during the attach, after the launch, restores once and exits 130", async () => {
  const exits = [];
  const fake = new EventEmitter();
  fake.exit = (code) => exits.push(code);
  let restores = 0;
  let launched = false;
  const _attach = async (config, options) => {
    launched = true;
    // The widget is up; the fake attach then hangs, as a page still settling does.
    options.onLaunch(() => { restores += 1; return RECORD; });
    await new Promise(() => {});
  };

  const pending = tvSession(CONFIG, { _attach, _process: fake });
  await until(() => launched && fake.listenerCount("SIGINT") === 1);

  fake.emit("SIGINT");
  await until(() => exits.length > 0);
  fake.emit("SIGTERM");

  assert.deepEqual(exits, [130], "the handler leaves with the signal's code");
  assert.equal(restores, 1, "the launch reaches the memoised restore, once");
  void pending;
});

test("row 15: a signal before the launch restores nothing and exits 130", async () => {
  const exits = [];
  const fake = new EventEmitter();
  fake.exit = (code) => exits.push(code);
  let attaching = false;
  let handed = null;
  let detaches = 0;
  const _attach = async (config, options) => {
    attaching = true;
    handed = options.onLaunch;
    await new Promise(() => {});
    return { detach: async () => { detaches += 1; return RECORD; } };
  };

  const pending = tvSession(CONFIG, { _attach, _process: fake });
  await until(() => attaching && fake.listenerCount("SIGINT") === 1);

  fake.emit("SIGINT");
  await until(() => exits.length > 0);

  assert.deepEqual(exits, [130]);
  assert.equal(typeof handed, "function", "the attach window is covered before the launch");
  assert.equal(detaches, 0, "nothing was handed over, so nothing was put back");
  void pending;
});

test("row 15: a signal detaches once, exits 130, and the finally runs no second restore", async () => {
  const exits = [];
  const fake = new EventEmitter();
  fake.exit = (code) => exits.push(code);
  let detaches = 0;
  let pending = null;
  const session = {
    cdp: {},
    port: 43411,
    protocol: null,
    timings: null,
    // attach's own contract: one run, however many callers reach it.
    detach() {
      pending ??= (async () => { detaches += 1; return RECORD; })();
      return pending;
    },
  };

  const hooked = await tvSession(CONFIG, { _attach: async () => session, _process: fake });
  fake.emit("SIGINT");
  await until(() => exits.length > 0);

  assert.deepEqual(exits, [130], "the handler leaves with the signal's code");
  assert.equal(detaches, 1, "one detach: kill, forward removal and restore");

  assert.deepEqual(await hooked.detach(), RECORD, "the caller's finally still gets the record");
  assert.equal(detaches, 1, "and shares the one run rather than restoring again");
  assert.equal(fake.listenerCount("SIGINT"), 0);
  assert.equal(fake.listenerCount("SIGTERM"), 0);
});

test("row 15: both handlers are removed once a normal detach settles", async () => {
  const fake = new EventEmitter();
  fake.exit = () => assert.fail("a normal detach must not exit the process");
  const session = { cdp: {}, port: 1, protocol: null, timings: null, detach: async () => RECORD };

  const hooked = await tvSession(CONFIG, { _attach: async () => session, _process: fake });
  assert.equal(fake.listenerCount("SIGINT"), 1);
  assert.equal(fake.listenerCount("SIGTERM"), 1);

  assert.deepEqual(await hooked.detach(), RECORD);
  assert.equal(fake.listenerCount("SIGINT"), 0);
  assert.equal(fake.listenerCount("SIGTERM"), 0);
});
