// Rows 10a–10c: the scheme a LIVE daemon is described by comes from its pid
// record, never from config. Config decides only what a start will serve, so
// toggling dashboard.https without a restart must not make status, the
// already-running short-circuit or the launcher describe a listener that is not
// there.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { runCli } from "./helpers/cli.mjs";
import { hostTrustHint, pidPath } from "../src/serve/daemon.mjs";

function tmp() {
  return mkdtempSync(join(tmpdir(), "swarm-scheme-"));
}

function seedHome(dir, dash) {
  const home = join(dir, "home");
  mkdirSync(home, { recursive: true });
  writeFileSync(join(home, "config.json"), JSON.stringify({
    providers: { claude: { enabled: true, allowedRoots: [dir] } },
    dashboard: { enabled: true, tray: false, bind: "127.0.0.1", ...dash },
  }), "utf8");
  return home;
}

async function freePort() {
  const s = createServer();
  await new Promise((r) => s.listen(0, "127.0.0.1", r));
  const port = s.address().port;
  await new Promise((r) => s.close(r));
  return port;
}

// A live process to stand in for a running daemon. The pid must be alive for
// statusReport/blockStart, but it must never be the test process itself —
// `serve restart` would signal it.
function idleProcess() {
  return spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], { stdio: "ignore", windowsHide: true });
}

function writeRecord(home, record) {
  writeFileSync(pidPath(home), JSON.stringify(record), "utf8");
}

const env = (home) => ({ SWARM_HOME: home, NODE_TEST_CONTEXT: "child-v8" });

test("row 10a: status and already-running describe the pid record's scheme, not the config's", async () => {
  const dir = tmp();
  const home = seedHome(dir, { port: 41999, https: false });
  const idle = idleProcess();
  try {
    writeRecord(home, { pid: idle.pid, port: 41999, scheme: "https", listening: true, version: "v1", startedMs: Date.now() });

    const status = runCli(["serve", "status"], { cwd: dir, env: env(home) });
    assert.equal(status.status, 0, status.stderr);
    assert.match(status.stdout, /https:\/\/[^/\s]+:41999\//, `config says http, the record says https:\n${status.stdout}`);
    assert.ok(!/http:\/\//.test(status.stdout), `no http URL for an https daemon:\n${status.stdout}`);

    const running = runCli(["serve"], { cwd: dir, env: env(home) });
    assert.equal(running.status, 0, running.stderr);
    assert.match(running.stdout, /already running/);
    assert.match(running.stdout, /https:\/\/[^/\s]+:41999\//, `already-running must print the record's scheme:\n${running.stdout}`);
    assert.ok(!/http:\/\//.test(running.stdout), running.stdout);
  } finally {
    idle.kill();
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test("row 10a: reversed — a record saying http stays http even when config says https", () => {
  const dir = tmp();
  const home = seedHome(dir, { port: 41999, https: true });
  const idle = idleProcess();
  try {
    writeRecord(home, { pid: idle.pid, port: 41999, scheme: "http", listening: true, version: "v1", startedMs: Date.now() });

    const status = runCli(["serve", "status"], { cwd: dir, env: env(home) });
    assert.equal(status.status, 0, status.stderr);
    assert.match(status.stdout, /http:\/\/[^/\s]+:41999\//, `config says https, the record says http:\n${status.stdout}`);
    assert.ok(!/https:\/\//.test(status.stdout), status.stdout);

    const running = runCli(["serve"], { cwd: dir, env: env(home) });
    assert.equal(running.status, 0, running.stderr);
    assert.match(running.stdout, /http:\/\/[^/\s]+:41999\//, running.stdout);
    assert.ok(!/https:\/\//.test(running.stdout), running.stdout);
  } finally {
    idle.kill();
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test("row 10a: a record written before scheme existed reads as http", () => {
  const dir = tmp();
  const home = seedHome(dir, { port: 41999, https: true });
  const idle = idleProcess();
  try {
    writeRecord(home, { pid: idle.pid, port: 41999, listening: true, version: "v1", startedMs: Date.now() });
    const status = runCli(["serve", "status"], { cwd: dir, env: env(home) });
    assert.equal(status.status, 0, status.stderr);
    assert.match(status.stdout, /http:\/\/[^/\s]+:41999\//, `an old record has no scheme → http:\n${status.stdout}`);
  } finally {
    idle.kill();
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

// Row 10b: the child fails before it ever listens. Without the wait, the parent
// printed "started pid N" and looked like success — the operator then had a
// dashboard that was not there and a log nobody had read.
test("row 10b: --daemon with an unreadable ~/.swarm/tls exits non-zero, prints no 'started', and logs tls-error", async () => {
  const dir = tmp();
  const port = await freePort();
  const home = seedHome(dir, { port, https: true });
  // ensureTls needs a directory; a regular file at that path makes it throw.
  writeFileSync(join(home, "tls"), "not a directory", "utf8");
  try {
    const r = runCli(["serve", "--daemon"], { cwd: dir, env: env(home) });
    assert.notEqual(r.status, 0, `a failed start must exit non-zero:\n${r.stdout}${r.stderr}`);
    assert.ok(!r.stdout.includes("dashboard: started"), `must not claim a start that did not happen:\n${r.stdout}`);
    const log = readFileSync(join(home, "dashboard.log"), "utf8");
    const lines = log.trim().split("\n").map((l) => JSON.parse(l));
    const err = lines.find((l) => l.event === "tls-error");
    assert.ok(err, `expected a tls-error event in dashboard.log, got:\n${log}`);
    assert.ok(err.msg || err.stack, "the failure carries its message/stack");
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

// Row 10c: restart is the verb the tray runs, so it must print the CA step too,
// not only --daemon. `swarm-ca.crt` is the one URL a phone has to reach before it
// trusts anything; the hint is the per-platform PC install command.
test("row 10c: an https restart prints the swarm-ca.crt line and the host-trust hint", async () => {
  const dir = tmp();
  const port = await freePort();
  const home = seedHome(dir, { port, https: true });
  let daemonPid = null;
  try {
    const r = runCli(["serve", "restart"], { cwd: dir, env: env(home) });
    assert.equal(r.status, 0, `restart must succeed:\n${r.stdout}${r.stderr}`);
    assert.match(r.stdout, /\/swarm-ca\.crt/, `the CA download URL is printed:\n${r.stdout}`);
    assert.ok(r.stdout.includes(hostTrustHint(process.platform, join(home, "tls", "ca.crt"))),
      `the per-platform trust hint is printed verbatim:\n${r.stdout}`);
    assert.match(r.stdout, /https:\/\/[^/\s]+:\d+\//, `and the URLs use the started scheme:\n${r.stdout}`);

    const record = JSON.parse(readFileSync(pidPath(home), "utf8"));
    daemonPid = record.pid;
    assert.equal(record.scheme, "https", "every record write carries the scheme the daemon serves");
  } finally {
    if (daemonPid) { try { process.kill(daemonPid); } catch { /* already gone */ } }
    await new Promise((r) => setTimeout(r, 300));
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});
