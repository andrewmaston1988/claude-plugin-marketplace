// Doctor's remote-control checks. The endpoint check runs inside the setup wizard
// at step 8/9 — before the daemon exists — so "nothing is listening" must read as
// informational, not a failure: a throw there makes the wizard print "fix them
// before starting the bridge" and skip the step-9 launch offer on every first
// enable, naming as the remedy the launch it just refused.
import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { runDoctor } from "../../src/doctor/index.mjs";

const noop = { info() {}, warn() {}, child() { return noop; } };
const paths = { stateDir: ".", configDir: ".", dataDir: ".", logDir: ".", configFile: "./nonexistent.json" };

function configFor(port) {
  return {
    tokens: { bot: "xoxb-test" },
    remote: { controlToken: "tok", controlPort: port, brokerPort: port },
  };
}

// A port nothing listens on: bind, read the number, release it.
async function freePort() {
  const srv = http.createServer();
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  const { port } = srv.address();
  await new Promise((r) => srv.close(r));
  return port;
}

async function checkNamed(config, name) {
  const results = await runDoctor({ config, paths, web: {}, log: noop });
  const found = results.find((r) => r.name === name);
  assert.ok(found, `${name} check must run`);
  return found;
}

test("endpoint unreachable reads as informational, not a failure", async () => {
  const port = await freePort();
  const r = await checkNamed(configFor(port), "Remote-control endpoint");
  assert.equal(r.ok, true, `unreachable endpoint must not fail the check — got: ${r.detail}`);
  assert.match(r.detail, /not running on \d+/);
});

test("endpoint 401 is still a failure", async () => {
  const srv = http.createServer((_req, res) => { res.writeHead(401); res.end("{}"); });
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  const { port } = srv.address();
  try {
    const r = await checkNamed(configFor(port), "Remote-control endpoint");
    assert.equal(r.ok, false, "a token mismatch must still fail — waiting never clears it");
    assert.match(r.detail, /token mismatch/);
  } finally {
    await new Promise((r) => srv.close(r));
  }
});

test("endpoint 5xx is still a failure", async () => {
  const srv = http.createServer((_req, res) => { res.writeHead(500); res.end("{}"); });
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  const { port } = srv.address();
  try {
    const r = await checkNamed(configFor(port), "Remote-control endpoint");
    assert.equal(r.ok, false, "a listening-but-unhealthy endpoint must still fail");
    assert.match(r.detail, /returned 500/);
  } finally {
    await new Promise((r) => srv.close(r));
  }
});
