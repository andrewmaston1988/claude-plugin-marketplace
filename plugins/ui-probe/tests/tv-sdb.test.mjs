import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { allowSdb, findSdb, packageId, parseDebugPort, sdb, SdbRefused } from "../src/tv/sdb.mjs";

const HOME = "C:/Users/me";
const APPID = "torrenthub.main";
const CONFIG = { tv: { host: "192.0.2.10:26101", appid: APPID } };

test("findSdb honours tv.sdb before PATH and the SDK layouts", () => {
  const got = findSdb(
    { tv: { sdb: "D:/tizen/sdb.exe" } },
    {
      _exists: (candidate) => candidate === "D:/tizen/sdb.exe",
      _spawnSync: () => assert.fail("PATH is consulted only when tv.sdb does not resolve"),
      _home: () => HOME,
    },
  );
  assert.equal(got, "D:/tizen/sdb.exe");
});

test("findSdb falls back to the PATH lookup", () => {
  const got = findSdb(
    { tv: {} },
    {
      _exists: () => false,
      _spawnSync: () => ({ status: 0, stdout: "C:/tools/sdb.exe\r\nC:/other/sdb.exe\r\n" }),
      _home: () => HOME,
    },
  );
  assert.equal(got, "C:/tools/sdb.exe");
});

test("findSdb falls back to both home-relative SDK layouts", () => {
  for (const rel of [".tizen-extension-platform/server/sdktools/data/tools", "tizen-studio/tools"]) {
    const wanted = path.join(HOME, rel);
    const got = findSdb(
      { tv: {} },
      {
        _exists: (candidate) => candidate.startsWith(wanted),
        _spawnSync: () => ({ status: 1, stdout: "" }),
        _home: () => HOME,
      },
    );
    assert.ok(got?.startsWith(wanted), `${rel}: got ${got}`);
  }
});

test("findSdb returns null when sdb is nowhere", () => {
  const got = findSdb(
    { tv: {} },
    { _exists: () => false, _spawnSync: () => ({ status: 1, stdout: "" }), _home: () => HOME },
  );
  assert.equal(got, null);
});

test("the sdb allowlist passes the attach sequence", () => {
  const allowed = [
    ["devices"],
    ["connect", "192.0.2.10:26101"],
    ["version"],
    ["shell", "0", "applist"],
    ["shell", "0", "debug", APPID],
    ["shell", "0", "kill", "torrenthub"],
    ["forward", "tcp:43411", "tcp:43411"],
    ["forward", "--remove", "tcp:43411"],
    ["forward", "--list"],
  ];
  for (const argv of allowed) assert.doesNotThrow(() => allowSdb(argv, { appid: APPID }), argv.join(" "));
});

test("the sdb allowlist refuses everything that is not the configured app's business", () => {
  const refused = [
    ["shell", "0", "debug", "torrenthub.tizen"],
    ["shell", "0", "debug", "other.main"],
    ["shell", "0", "kill", "otherthing"],
    ["shell", "0", "kill", APPID],
    ["install", "torrenthub.wgt"],
    ["uninstall", "torrenthub"],
    ["kill-server"],
    ["shell", "ls", "/"],
    ["shell", "0", "sendkey", "KEY_LEFT"],
    ["shell", "0", "inputkey", "KEY_LEFT"],
    ["shell", "0", "key", "KEY_LEFT"],
    ["connect", "192.0.2.10"],
    ["forward", "tcp:43411", "tcp:9222"],
    ["forward", "--remove", "tcp:*"],
  ];
  for (const argv of refused) assert.throws(() => allowSdb(argv, { appid: APPID }), SdbRefused, argv.join(" "));
});

test("a refused argv is named in the error", () => {
  assert.throws(() => allowSdb(["install", "torrenthub.wgt"], { appid: APPID }), /sdb install torrenthub\.wgt is off the allowlist/);
});

test("an appid-less tv block may read but not launch or kill", () => {
  assert.doesNotThrow(() => allowSdb(["shell", "0", "applist"], {}));
  assert.throws(() => allowSdb(["shell", "0", "debug", APPID], {}), SdbRefused);
  assert.throws(() => allowSdb(["shell", "0", "kill", "torrenthub"], {}), SdbRefused);
});

test("sdb runs the allowlisted argv with shell: false", () => {
  const calls = [];
  const result = sdb(["shell", "0", "applist"], {
    config: CONFIG,
    _findSdb: () => "C:/tools/sdb.exe",
    _spawn: (command, argv, options) => {
      calls.push({ command, argv, options });
      return { status: 0, stdout: "'Torrent Hub' 'torrenthub.main'", stderr: "" };
    },
  });
  assert.deepEqual(calls, [
    {
      command: "C:/tools/sdb.exe",
      argv: ["shell", "0", "applist"],
      options: { encoding: "utf8", timeout: 30000, windowsHide: true, shell: false },
    },
  ]);
  assert.deepEqual(result, { stdout: "'Torrent Hub' 'torrenthub.main'", stderr: "", code: 0 });
});

test("sdb refuses an off-allowlist argv before spawning anything", () => {
  let spawned = false;
  assert.throws(
    () =>
      sdb(["install", "torrenthub.wgt"], {
        config: CONFIG,
        _findSdb: () => "C:/tools/sdb.exe",
        _spawn: () => {
          spawned = true;
        },
      }),
    SdbRefused,
  );
  assert.equal(spawned, false);
});

test("sdb passes its timeout to spawn and reports a timed-out child as non-zero", () => {
  let options = null;
  const result = sdb(["shell", "0", "debug", APPID], {
    config: CONFIG,
    timeoutMs: 120,
    _findSdb: () => "C:/tools/sdb.exe",
    _spawn: (_command, _argv, spawnOptions) => {
      options = spawnOptions;
      return { status: null, error: new Error("ETIMEDOUT"), stdout: "", stderr: "" };
    },
  });
  assert.equal(options.timeout, 120);
  assert.equal(result.code, 2);
});

test("sdb without a found binary names the config key and the SDK", () => {
  assert.throws(
    () => sdb(["devices"], { config: CONFIG, _findSdb: () => null }),
    /tv\.sdb/,
  );
});

test("parseDebugPort reads the launched port and nothing else", () => {
  const line = "launching... successfully launched pid = 921 with debug 1 port: 43411";
  assert.equal(parseDebugPort(line), 43411);
  assert.equal(parseDebugPort("Pkgid: torrenthub is Terminated"), null);
  assert.equal(parseDebugPort(""), null);
  assert.equal(parseDebugPort(undefined), null);
});

test("packageId is the app id up to its first dot", () => {
  assert.equal(packageId("torrenthub.main"), "torrenthub");
  assert.equal(packageId("torrenthub"), "torrenthub");
  assert.equal(packageId("a.b.c"), "a");
});
