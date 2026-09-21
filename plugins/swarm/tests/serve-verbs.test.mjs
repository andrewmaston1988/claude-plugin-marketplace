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
    // The tray's only route back on is `node <ShimPath> scripts/swarm.mjs serve enable`
    // (tray.ps1's Start-SwarmEnable), so the file argv names must exist by the time the
    // tray gets it. A path to a file nobody wrote spawns a tray whose Enable exits
    // "Cannot find module" and reports nothing. Read from the argv rather than a
    // hardcoded path — the path the tray is handed is the only one it can run.
    const at = calls[0].argv.indexOf("-ShimPath");
    const shim = calls[0].argv[at + 1];
    ok(at > 0 && existsSync(shim), `the shim the tray must run has to exist: ${shim}`);
    equal(await portAnswers(port), false, "the webserver must not launch");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- serve enable / serve disable: the single write path the tray and setup share ---

test("serve disable then enable flips exactly one key and leaves the rest of the file intact", async () => {
  const dir = tmp();
  const port = await freePort();
  const home = join(dir, "home");
  mkdirSync(home, { recursive: true });
  const configPath = join(home, "config.json");
  // A config with something to disturb in every direction: nested objects, an
  // array, a legacy-shaped key, and the dashboard block itself.
  const seeded = {
    providers: { claude: { allowedRoots: [dir] }, ollama: { enabled: false, url: "http://localhost:11434" } },
    concurrency: 4,
    projects: [{ name: "one", hooks: {} }, { name: "two", hooks: {} }],
    modelDenylist: ["nemotron"],
    dashboard: { enabled: true, port, bind: "127.0.0.1", tray: true },
  };
  writeFileSync(configPath, JSON.stringify(seeded, null, 2) + "\n");
  const env = { SWARM_CONFIG: configPath, SWARM_SERVE_TEST_TRAY: join(dir, "tray.jsonl") };
  try {
    const off = runCli(["serve", "disable"], { cwd: dir, env });
    equal(off.status, 0, off.stderr);
    const after = JSON.parse(readFileSync(configPath, "utf8"));
    equal(after.dashboard.enabled, false);
    // Everything else byte-for-byte: a writer that re-materialises the file from the
    // defaults would silently re-enable a provider or drop the denylist.
    equal(JSON.stringify({ ...after, dashboard: { ...after.dashboard, enabled: true } }), JSON.stringify(seeded));

    const on = runCli(["serve", "enable"], { cwd: dir, env });
    equal(on.status, 0, on.stderr);
    equal(JSON.parse(readFileSync(configPath, "utf8")).dashboard.enabled, true, "and back");
    // Neither verb starts anything: the answer is observable without a side effect,
    // so setup can ask and then offer to start.
    equal(existsSync(join(dir, "tray.jsonl")), false, "enable/disable write the key; they do not launch the tray");
    equal(await portAnswers(port), false, "nor the webserver");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("serve enable on a machine with no config file creates one carrying only that key", async () => {
  const dir = tmp();
  const home = join(dir, "home");
  mkdirSync(home, { recursive: true });
  const configPath = join(home, "config.json");
  try {
    const r = runCli(["serve", "enable"], { cwd: dir, env: { SWARM_CONFIG: configPath } });
    equal(r.status, 0, r.stderr);
    // The one key, not a materialised copy of the defaults: `swarm config init` is
    // the command that fills a file out, and a verb asked to change one setting
    // must not decide the rest of them for the operator.
    equal(readFileSync(configPath, "utf8").trim(), JSON.stringify({ dashboard: { enabled: true } }, null, 2));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// The disabled-serve contract above is platform-independent logic — `serve` must
// reach launchTray rather than return early — but the tray's own win32 gate made
// the row Windows-only, so it failed on the Linux CI runner that never records a
// spawn. The recorder is the test harness's own seam: when it is armed, the gate
// yields to it and the row bites on every OS.
test("the tray recorder overrides the win32 gate, so the disabled path is pinned on any OS", async () => {
  const dir = tmp();
  const home = join(dir, "home");
  mkdirSync(home, { recursive: true });
  const trayLog = join(dir, "tray.jsonl");
  try {
    const { launchTray } = await import("../src/serve/tray.mjs");
    const env = { NODE_TEST_CONTEXT: "1", SWARM_SERVE_TEST_TRAY: trayLog };
    const rec = await launchTray({ home, port: 41999, platform: "linux", disabled: true, env });
    equal(rec.recorded, true, `a recorder armed on a non-win32 platform must still record: ${JSON.stringify(rec)}`);
    ok(readFileSync(trayLog, "utf8").includes("-Disabled"), "and record the disabled argv");
    // `tray: false` is the operator's own switch and outranks the recorder.
    equal((await launchTray({ home, port: 41999, platform: "linux", tray: false, env })).skipped, true);
    // Without the recorder a non-win32 platform still spawns nothing.
    equal((await launchTray({ home, port: 41999, platform: "linux", env: { NODE_TEST_CONTEXT: "1" } })).skipped, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
