import { test } from "node:test";
import assert from "node:assert/strict";
import { allowRest, appStatus, launchApp, restBase, RestRefused, RestStatus } from "../src/tv/rest.mjs";

const BASE = "http://192.0.2.10:8001";
const WIDGET = "torrenthub.shell";
const APPLE_TV = "3201807016597";

/** One response in the shape the plugin's own `fetch` returns. */
const answer = (body, status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  text: async () => (typeof body === "string" ? body : JSON.stringify(body)),
});

test("the REST allowlist reads any application id", () => {
  for (const id of ["OEvCiupaFR.ITVHub", "111299001912", APPLE_TV, WIDGET, "3KA0pm7a7V.TubiTV"]) {
    assert.doesNotThrow(() => allowRest("GET", `/api/v2/applications/${id}`), id);
  }
});

test("the REST allowlist posts only the app this session detected", () => {
  const posted = `/api/v2/applications/${APPLE_TV}`;
  assert.doesNotThrow(() => allowRest("POST", posted, { launchable: APPLE_TV, widget: WIDGET }));

  const refused = [
    ["POST", "/api/v2/applications/9Ur5IzDKqV.TizenYouTube", { launchable: APPLE_TV, widget: WIDGET }],
    // The widget's own id never goes back, even when a caller names it as the launchable.
    ["POST", `/api/v2/applications/${WIDGET}`, { launchable: WIDGET, widget: WIDGET }],
    ["POST", posted, { widget: WIDGET }],
    ["POST", `${posted}/`, { launchable: APPLE_TV, widget: WIDGET }],
    ["POST", "/api/v2/applications", { launchable: APPLE_TV, widget: WIDGET }],
    ["POST", `${posted}?x=1`, { launchable: APPLE_TV, widget: WIDGET }],
    ["POST", `/api/v2/other/${APPLE_TV}`, { launchable: APPLE_TV, widget: WIDGET }],
    ["POST", `${BASE}${posted}`, { launchable: APPLE_TV, widget: WIDGET }],
    ["PUT", posted, { launchable: APPLE_TV, widget: WIDGET }],
    ["DELETE", posted, { launchable: APPLE_TV, widget: WIDGET }],
    ["GET", "/api/v2/applications", {}],
    ["GET", "/api/v2/applications/", {}],
    ["GET", `${posted}/`, {}],
  ];
  for (const [method, path, options] of refused) {
    assert.throws(() => allowRest(method, path, options), RestRefused, `${method} ${path}`);
  }
});

test("a refused id makes no request at all", async () => {
  let calls = 0;
  const _fetch = async () => {
    calls += 1;
    return answer({});
  };

  await assert.rejects(appStatus(BASE, "../etc/passwd", { _fetch, timeoutMs: 100 }), RestRefused);
  await assert.rejects(appStatus(BASE, "", { _fetch, timeoutMs: 100 }), RestRefused);
  await assert.rejects(
    launchApp(BASE, "9Ur5IzDKqV.TizenYouTube", { launchable: APPLE_TV, widget: WIDGET, _fetch }),
    RestRefused,
  );
  await assert.rejects(
    launchApp(BASE, WIDGET, { launchable: WIDGET, widget: WIDGET, _fetch }),
    RestRefused,
  );
  assert.equal(calls, 0, "the wire must never see a refused call");
});

test("restBase swaps tv.host's sdb port for the TV's REST port", () => {
  assert.equal(restBase("192.0.2.10:26101"), BASE);
  assert.equal(restBase("192.0.2.10"), BASE);
  assert.throws(() => restBase(""), /tv\.host/);
  assert.throws(() => restBase(undefined), /tv\.host/);
});

test("appStatus reads one application record", async () => {
  const calls = [];
  const body = { id: "OEvCiupaFR.ITVHub", name: "ITVX", running: true, version: "1.2.3", visible: true };
  const _fetch = async (url, options) => {
    calls.push({ url, method: options.method });
    return answer(body);
  };

  const status = await appStatus(BASE, "OEvCiupaFR.ITVHub", { _fetch, timeoutMs: 100 });
  assert.deepEqual(status, { id: "OEvCiupaFR.ITVHub", name: "ITVX", running: true, visible: true });
  assert.deepEqual(calls, [{ url: `${BASE}/api/v2/applications/OEvCiupaFR.ITVHub`, method: "GET" }]);
});

test("a visible record needs the flag as a real true", async () => {
  const _fetch = async () => answer({ id: "111299001912", name: "YouTube", running: "true", visible: "true" });
  const status = await appStatus(BASE, "111299001912", { _fetch, timeoutMs: 100 });
  assert.equal(status.visible, false, "a string is not the foreground signal the probe measured");
  assert.equal(status.running, false);
});

test("a non-200 answer throws RestStatus carrying the status", async () => {
  const _fetch = async () => answer({ code: 404, message: "Not Found" }, 404);
  await assert.rejects(
    appStatus(BASE, "com.samsung.tv.aria-dummy", { _fetch, timeoutMs: 100 }),
    (error) => {
      assert.ok(error instanceof RestStatus);
      assert.equal(error.status, 404);
      assert.match(error.message, /HTTP 404/);
      return true;
    },
  );
});

test("an application read that outlives its timeoutMs is aborted", async () => {
  let seen = null;
  const _fetch = (url, { signal }) => new Promise((resolve, reject) => {
    seen = signal;
    signal.addEventListener("abort", () => {
      const error = new Error("The operation was aborted");
      error.name = "AbortError";
      reject(error);
    });
  });

  await assert.rejects(appStatus(BASE, "111299001912", { _fetch, timeoutMs: 20 }), /did not answer within 20 ms/);
  assert.equal(seen.aborted, true, "the request was left with a signal that fired");
});

test("a body that is not JSON throws plainly, not as a status", async () => {
  const _fetch = async () => answer("<html>not the TV's REST API</html>");
  await assert.rejects(
    appStatus(BASE, "111299001912", { _fetch, timeoutMs: 100 }),
    (error) => {
      assert.equal(error instanceof RestStatus, false);
      assert.match(error.message, /not JSON/);
      return true;
    },
  );
});

test("launchApp retries an empty body once, 1 s later, and returns the second answer", async () => {
  const sleeps = [];
  const bodies = ["", '{"running":true,"visible":true}'];
  let calls = 0;
  const _fetch = async () => answer(bodies[calls++]);

  const body = await launchApp(BASE, APPLE_TV, {
    launchable: APPLE_TV,
    widget: WIDGET,
    _fetch,
    _sleep: async (ms) => { sleeps.push(ms); },
  });

  assert.deepEqual(body, { running: true, visible: true });
  assert.equal(calls, 2);
  assert.deepEqual(sleeps, [1000], "exactly one retry, one second later");
});

test("three empty bodies throw naming the empty body", async () => {
  let calls = 0;
  const _fetch = async () => {
    calls += 1;
    return answer("");
  };

  await assert.rejects(
    launchApp(BASE, APPLE_TV, { launchable: APPLE_TV, widget: WIDGET, _fetch, _sleep: async () => {} }),
    /empty body/,
  );
  assert.equal(calls, 3, "three attempts in total");
});

test("a JSON answer on the first POST needs no retry", async () => {
  const sleeps = [];
  const _fetch = async () => answer({ running: true, visible: false });

  const body = await launchApp(BASE, APPLE_TV, {
    launchable: APPLE_TV,
    widget: WIDGET,
    _fetch,
    _sleep: async (ms) => { sleeps.push(ms); },
  });

  assert.deepEqual(body, { running: true, visible: false });
  assert.deepEqual(sleeps, []);
});
