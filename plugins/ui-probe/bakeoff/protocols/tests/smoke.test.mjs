// Offline smoke test: every egress point is a fake injected at call time.
//
// Nothing here opens a socket, calls fetch or spawns a process. The fakes are passed to the
// adapter factories at call time (no factory defaults to a real dependency), and
// globalThis.fetch is replaced with a throwing stub for the duration, so an adapter that
// quietly reached for the real thing fails loudly instead of passing.
//
//   node --test plugins/ui-probe/bakeoff/protocols/tests/

import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";

import { createHttpAdapter } from "../adapters/http-fetch.mjs";
import { createHurlAdapter } from "../adapters/hurl.mjs";
import { createQbittorrentAdapter } from "../adapters/qbittorrent.mjs";
import { createSshAdapter } from "../adapters/ssh-batch.mjs";
import { createTcpAdapter } from "../adapters/tcp-net.mjs";
import { FIXTURE_SESSION, SCAN_STATUS_IDLE } from "../fixtures/http-server.mjs";
import { BANNER } from "../fixtures/tcp-echo.mjs";
import { drive, driveGuards, SCHEMA } from "../harness.mjs";
import { TASKS } from "../tasks.mjs";

const realFetch = globalThis.fetch;

function socketFake({ banner = BANNER, onWrite = null } = {}) {
  const socket = new EventEmitter();
  socket.setEncoding = () => {};
  socket.setTimeout = () => {};
  socket.destroy = () => {};
  socket.write = (chunk) => {
    if (onWrite) onWrite(chunk);
    queueMicrotask(() => socket.emit("data", `250 ${chunk}`));
    return true;
  };
  queueMicrotask(() => {
    socket.emit("connect");
    queueMicrotask(() => socket.emit("data", banner));
  });
  return socket;
}

function netFake({ connectsTo = true, banner } = {}) {
  return {
    connect({ port }) {
      if (port === 22 || !connectsTo) {
        const dead = new EventEmitter();
        dead.setTimeout = () => {};
        dead.destroy = () => {};
        queueMicrotask(() => dead.emit("error", new Error("ECONNREFUSED")));
        return dead;
      }
      return socketFake({ banner });
    },
  };
}

function response(status, headers, body) {
  const map = new Map(Object.entries(headers));
  return {
    status,
    statusText: status === 200 ? "OK" : status === 302 ? "Found" : "Not Found",
    headers: { entries: () => map.entries(), get: (name) => map.get(name) ?? null },
    text: async () => body,
  };
}

function fetchFake() {
  const calls = [];
  const impl = async (url, init = {}) => {
    calls.push({ url, method: init.method ?? "GET", init });
    const path = new URL(url).pathname;
    if (path === "/api/scan-status") {
      if (init.redirect !== "manual") throw new Error("the probe must not follow redirects");
      const cookie = init.headers?.cookie ?? "";
      if (!cookie.includes(FIXTURE_SESSION)) {
        return response(302, { location: "/pin", "set-cookie": "profile_session=; Max-Age=0" }, "");
      }
      return response(
        200,
        {
          "content-type": "application/json",
          "set-cookie": `profile_session=${FIXTURE_SESSION}; Path=/; HttpOnly`,
        },
        JSON.stringify(SCAN_STATUS_IDLE),
      );
    }
    return response(404, { "content-type": "application/json" }, '{"detail":"Not Found"}');
  };
  return { impl, calls };
}

function sshAdapterFake() {
  const spawned = [];
  const spawn = async (argv) => {
    spawned.push(argv);
    return { code: 255, stdout: "", stderr: "ssh: connect to host localhost port 22: Connection refused" };
  };
  return { adapter: createSshAdapter({ spawn, net: netFake() }), spawned };
}

test("no adapter reaches the real network", async () => {
  globalThis.fetch = () => {
    throw new Error("a real fetch escaped the harness");
  };
  try {
    const { impl } = fetchFake();
    const tasks = Object.fromEntries(TASKS.map((t) => [t.id, t]));
    const http = createHttpAdapter({
      fetchImpl: impl,
      target: { host: "127.0.0.1", port: 5999, origin: "http://127.0.0.1:5999" },
      headers: { cookie: `profile_session=${FIXTURE_SESSION}` },
      secrets: [FIXTURE_SESSION],
    });
    const observation = await http.probe(tasks["http.scan-status"]);
    assert.match(observation.transcript, /< HTTP 200 OK/);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("http transcript redacts the session cookie and its Set-Cookie", async () => {
  const { impl } = fetchFake();
  const tasks = Object.fromEntries(TASKS.map((t) => [t.id, t]));
  const http = createHttpAdapter({
    fetchImpl: impl,
    target: { host: "127.0.0.1", port: 5999, origin: "http://127.0.0.1:5999" },
    headers: { cookie: `profile_session=${FIXTURE_SESSION}` },
    secrets: [FIXTURE_SESSION],
  });

  const authed = await http.probe(tasks["http.scan-status"]);
  assert.ok(tasks["http.scan-status"].verify(authed), "the authenticated read must verify");
  assert.match(authed.transcript, /> cookie: <redacted>/);
  assert.match(authed.transcript, /< set-cookie: <redacted>/);
  assert.doesNotMatch(authed.transcript, new RegExp(FIXTURE_SESSION));

  const anon = await http.probe(tasks["http.scan-status-anon"]);
  assert.ok(tasks["http.scan-status-anon"].verify(anon), "the anonymous read must see the /pin redirect");
  assert.match(anon.transcript, /< HTTP 302 Found/);
  assert.match(anon.transcript, /< location: \/pin/);

  const missing = await http.probe(tasks["http.missing"]);
  assert.ok(tasks["http.missing"].verify(missing));
  assert.match(missing.transcript, /< HTTP 404/);
});

test("http guard refuses a POST before it reaches fetch", async () => {
  const { impl, calls } = fetchFake();
  const http = createHttpAdapter({
    fetchImpl: impl,
    target: { host: "127.0.0.1", port: 5999, origin: "http://127.0.0.1:5999" },
  });
  const bite = await http.guard.bite();
  assert.equal(bite.blocked, true, bite.message);
  assert.equal(calls.filter((call) => call.method !== "GET").length, 0, "no non-GET may reach fetch");
});

test("tcp adapter reads a banner, echoes an allowed write, and refuses any other", async () => {
  const written = [];
  const tasks = Object.fromEntries(TASKS.map((t) => [t.id, t]));
  const adapter = createTcpAdapter({
    net: { connect: () => socketFake({ onWrite: (chunk) => written.push(String(chunk)) }) },
    host: "127.0.0.1",
    port: 5999,
  });

  const banner = await adapter.probe(tasks["tcp.banner"]);
  assert.ok(tasks["tcp.banner"].verify(banner), banner.transcript);
  assert.match(banner.transcript, /^CONNECT 127\.0\.0\.1:5999$/m);

  const echo = await adapter.probe(tasks["tcp.echo"]);
  assert.ok(tasks["tcp.echo"].verify(echo), echo.transcript);
  assert.deepEqual(written, ["HELLO ui-probe\r\n"], "only the allowlisted line may be written");

  const bite = await adapter.guard.bite();
  assert.equal(bite.blocked, true, bite.message);
  assert.deepEqual(written, ["HELLO ui-probe\r\n"], "the refused write must not reach the socket");
});

test("tcp guard refuses a non-allowlisted write", async () => {
  const written = [];
  const adapter = createTcpAdapter({
    net: { connect: () => socketFake({ onWrite: (chunk) => written.push(String(chunk)) }) },
    host: "127.0.0.1",
    port: 5999,
  });
  const bite = await adapter.guard.bite();
  assert.equal(bite.blocked, true, bite.message);
  assert.match(bite.message, /off the allowlist/);
  assert.deepEqual(written, [], "a refused write must never reach the socket");
});

test("ssh without an sshd is OPEN, and its guard refuses a remote command", async () => {
  const { adapter, spawned } = sshAdapterFake();
  const observation = await adapter.probe();
  assert.ok(observation.open, "no sshd means OPEN, never a fabricated pass");
  assert.match(observation.open.probe, /BatchMode=yes/);
  assert.match(observation.open.evidence, /Connection refused/);
  assert.equal(spawned.length, 1, "one attempt, to show the real refusal");

  const bite = await adapter.guard.bite();
  assert.equal(bite.blocked, true, bite.message);
  assert.equal(spawned.length, 1, "the refused command must not spawn ssh");
});

test("every contender emits the same row shape", async () => {
  const { impl } = fetchFake();
  const { adapter: ssh } = sshAdapterFake();
  const adapters = [
    createHttpAdapter({
      fetchImpl: impl,
      target: { host: "127.0.0.1", port: 5999, origin: "http://127.0.0.1:5999" },
      headers: { cookie: `profile_session=${FIXTURE_SESSION}` },
      secrets: [FIXTURE_SESSION],
    }),
    createTcpAdapter({ net: netFake(), host: "127.0.0.1", port: 5999 }),
    ssh,
    createHurlAdapter({ which: () => null }),
    createQbittorrentAdapter(),
  ];
  const tasks = TASKS;
  const rows = await drive({ adapters, tasks, repeats: 2 });
  assert.ok(rows.length >= 6, `expected rows for every adapter, got ${rows.length}`);

  const keys = [...Object.keys(rows[0])].sort();
  for (const row of rows) {
    assert.equal(row.schema, SCHEMA);
    assert.deepEqual([...Object.keys(row)].sort(), keys, `row shape differs: ${row.contender}/${row.task}`);
  }

  const guards = await driveGuards({ adapters });
  assert.equal(guards.length, adapters.length);
  assert.equal(guards.filter((g) => g.blocked).length, 3, "http, tcp and ssh guards must all bite");
});
