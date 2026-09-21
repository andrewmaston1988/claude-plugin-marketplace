import { test } from "node:test";
import { equal, ok } from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createServer, connect } from "node:net";
import { runCli } from "./helpers/cli.mjs";

// `swarm serve` with the dashboard switched off. The gate that skips the server is
// the right idea — it is what makes `dashboard.enabled: false` mean anything — but
// it must not take the tray down with it: the tray is the ONLY surface an operator
// has left to turn the dashboard back on, and returning before it spawns leaves an
// off switch with nothing on the other side of it.

function tmp() {
  return mkdtempSync(join(tmpdir(), "swarm-serveverbs-"));
}

async function freePort() {
  const s = createServer();
  await new Promise((r) => s.listen(0, "127.0.0.1", r));
  const port = s.address().port;
  await new Promise((r) => s.close(r));
  return port;
}

function portAnswers(port) {
  return new Promise((resolve) => {
    const sock = connect({ port, host: "127.0.0.1" });
    const done = (v) => { sock.destroy(); resolve(v); };
    sock.once("connect", () => done(true));
    sock.once("error", () => done(false));
    setTimeout(() => done(false), 1500);
  });
}

// The tray is stubbed rather than spawned: a real NotifyIcon would appear on the
// operator's desktop every time this suite runs. Same seam shape as
// SWARM_SERVE_TEST_CRASH — armed only under `node --test`.
function serveHome(dir, dash) {
  const home = join(dir, "home");
  mkdirSync(home, { recursive: true });
  const trayLog = join(dir, "tray.jsonl");
  writeFileSync(join(home, "config.json"), JSON.stringify({
    providers: { claude: { allowedRoots: [dir] } },
    dashboard: dash,
  }));
  return { home, trayLog };
}

test("serve with the dashboard disabled spawns the tray and never binds the port", async () => {
  const dir = tmp();
  const port = await freePort();
  const { home, trayLog } = serveHome(dir, { enabled: false, port, tray: true });
  try {
    const r = runCli(["serve"], { cwd: dir, env: { SWARM_HOME: home, SWARM_SERVE_TEST_TRAY: trayLog } });
    equal(r.status, 0, r.stderr);
    ok(r.stdout.includes("disabled"), `the operator is told why the dashboard is not up:\n${r.stdout}`);
    // BOTH halves. "the port is free" alone passes the broken behaviour unchanged —
    // it spawns neither the server nor the tray, so the port is free either way.
    ok(existsSync(trayLog), "the tray must still spawn: it is the only way back to enabled");
    const calls = readFileSync(trayLog, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
    equal(calls.length, 1, "one tray, not a fleet of them");
    const argv = calls[0].argv.join(" ");
    ok(argv.includes("tray.ps1"), argv);
    ok(argv.includes(String(port)), `the tray is told the port to open: ${argv}`);
    ok(argv.includes(home), `the tray is told which home to re-enable against: ${argv}`);
    equal(await portAnswers(port), false, "the webserver must not launch");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
