import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync, readdirSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import {
  writePid, readPid, clearPid, isAlive, urlLines, firewallHint, installAutostart, uninstallAutostart, launcherPath,
  pidPath, resolveInstalled, isStale, blocksStart, bindFailureRecordAction, waitForDaemon, statusReport, doctorChecks, doctorExit, ensureShim,
  waitForExit, restartPlan,
} from "../src/serve/daemon.mjs";
import { createLogger } from "../src/serve/log.mjs";

const RESOLVER_SRC = fileURLToPath(new URL("../statusline/resolver.mjs", import.meta.url));
const tmpHome = () => mkdtempSync(join(tmpdir(), "swarm-home-"));

test("pid record: write/read round trip keeps every field; atomic (no .tmp left); clear is idempotent", () => {
  const home = mkdtempSync(join(tmpdir(), "swarm-pid-"));
  try {
    assert.equal(readPid(home), null);
    writePid(home, { pid: 4321, port: 7331, version: "0d6f126", startedMs: 1757308800000 });
    assert.deepEqual(readPid(home), { pid: 4321, port: 7331, version: "0d6f126", startedMs: 1757308800000 });
    assert.ok(!readdirSync(home).some((f) => f.endsWith(".tmp")));
    clearPid(home);
    assert.equal(readPid(home), null);
    clearPid(home); // idempotent
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test("pid record: a bare-integer file still reads as { pid } so an old daemon stays stoppable; garbage reads as null", () => {
  const home = tmpHome();
  try {
    writeFileSync(pidPath(home), "12345\n", "utf8");
    assert.deepEqual(readPid(home), { pid: 12345 }, "integer back-compat: no throw, pid only");
    writeFileSync(pidPath(home), "not json at all", "utf8");
    assert.equal(readPid(home), null);
    writeFileSync(pidPath(home), '{"port":7331}', "utf8");
    assert.equal(readPid(home), null, "a record without a pid is not a record");
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test("resolveInstalled: newest user-scoped entry wins; missing entry and unreadable registry read as null", () => {
  const dir = tmpHome();
  try {
    const reg = join(dir, "installed_plugins.json");
    const writeReg = (plugins) => writeFileSync(reg, JSON.stringify({ plugins }), "utf8");
    const key = "swarm@andrewmaston1988-claude-plugins";
    writeReg({ [key]: [
      { scope: "user", installPath: "/old", version: "v1", lastUpdated: "2026-01-01T00:00:00Z" },
      { scope: "user", installPath: "/new", version: "v2", lastUpdated: "2026-02-01T00:00:00Z" },
    ] });
    assert.deepEqual(resolveInstalled({ registry: reg }), { installPath: "/new", version: "v2" });
    // no user-scoped entries → fall back to the whole pool, as the resolver shim does
    writeReg({ [key]: [{ scope: "project", installPath: "/proj", version: "v3", lastUpdated: "2026-03-01T00:00:00Z" }] });
    assert.deepEqual(resolveInstalled({ registry: reg }), { installPath: "/proj", version: "v3" });
    writeReg({});
    assert.equal(resolveInstalled({ registry: reg }), null, "entry missing → null");
    writeFileSync(reg, "{ truncated", "utf8");
    assert.equal(resolveInstalled({ registry: reg }), null, "mid-write/unparsable registry → null, never a throw");
    assert.equal(resolveInstalled({ registry: join(dir, "absent.json") }), null);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("isStale: moves when, and only when, the VERSION moves", () => {
  const rec = { pid: 1, version: "v1", installPath: "/a" };
  assert.equal(isStale(rec, { installPath: "/a", version: "v1" }), false, "same version → not stale");
  assert.equal(isStale(rec, { installPath: "/moved", version: "v1" }), false,
    "path moved, version same → not stale: a path change alone is not a restart signal");
  assert.equal(isStale(rec, { installPath: "/a", version: "v2" }), true, "different version (path unchanged) → stale");
  assert.equal(isStale(rec, null), false, "registry entry missing/unreadable → never stale (no restart loop on a read blip)");
  assert.equal(isStale({ pid: 1, installPath: "/a" }, { installPath: "/a", version: "v2" }), false,
    "record without a version (old format) → not stale; serve restart is that path");
});

test("blocksStart: a live rival blocks start unless its version has moved; unknown registry still blocks", () => {
  const rival = { pid: 4321, version: "v1" };
  assert.equal(blocksStart(rival, { version: "v1" }, 7, true), true, "same version, live rival → short-circuit");
  assert.equal(blocksStart(rival, { version: "v2" }, 7, true), false, "stale rival → starting is a takeover");
  assert.equal(blocksStart(rival, null, 7, true), true, "registry unreadable → block, exactly like today");
  assert.equal(blocksStart({ pid: 4321 }, { version: "v2" }, 7, true), true, "rival record without a version → block (restart replaces it)");
  assert.equal(blocksStart({ ...rival, pid: 7 }, { version: "v1" }, 7, true), false, "our own pid is us, not a rival");
  assert.equal(blocksStart(rival, { version: "v1" }, 7, false), false, "dead rival blocks nothing");
  assert.equal(blocksStart(null, { version: "v2" }, 7, false), false);
});

test("bindFailureRecordAction: a failed bind hands the record back to a live rival, clears only its own", () => {
  const own = 7, rival = { pid: 4321, version: "v1" };
  const action = (current, prev) => bindFailureRecordAction({ current, prevRecord: prev, ownPid: own, alive: (pid) => pid === 4321 });
  assert.deepEqual(action({ pid: own }, rival), { act: "restore", record: rival },
    "we displaced a live rival and lost the bind → its record must survive so serve stop can reach it");
  assert.deepEqual(action({ pid: own }, { pid: 99 }), { act: "clear" }, "no live rival → the record was ours to clear");
  assert.deepEqual(action({ pid: 4321 }, rival), { act: "leave" }, "ownership already moved on → touch nothing");
});

test("waitForDaemon: listening → ok; dead before listening → fail; cleared and reverted records fail a handover fast", async () => {
  const alive = (pid) => pid === 999;
  const drive = (reads, opts = {}) => {
    const sleeps = [];
    let i = 0;
    return waitForDaemon({
      read: () => reads[Math.min(i++, reads.length - 1)],
      isAlive: alive, sleep: async (ms) => { sleeps.push(ms); },
      now: () => sleeps.length * 250, // the clock advances one poll per sleep, so a stuck loop still times out
      pollMs: 250, deadlineMs: 15000, ...opts,
    }).then((r) => ({ r, sleeps }));
  };
  const { r: ok, sleeps: s1 } = await drive([{ pid: 999 }, { pid: 999, listening: true }]);
  assert.equal(ok.ok, true);
  assert.equal(ok.record.pid, 999);
  assert.equal(s1.length, 1);
  const { r: dead } = await drive([{ pid: 998 }]);
  assert.equal(dead.ok, false);
  assert.match(dead.reason, /died before listening/);
  const { r: cleared } = await drive([{ pid: 999 }, { pid: 999 }, null],
    { failOnCleared: true, excludePid: 111 });
  assert.equal(cleared.ok, false);
  assert.match(cleared.reason, /record was cleared/);
  const { r: reverted } = await drive([{ pid: 999 }, { pid: 111 }],
    { revertIsFailure: true, excludePid: 111 });
  assert.equal(reverted.ok, false);
  assert.match(reverted.reason, /reverted/);
  const { r: timeout } = await drive([{ pid: 111 }], { excludePid: 111 });
  assert.equal(timeout.ok, false);
  assert.match(timeout.reason, /timed out/);
});

test("statusReport: not running / running current / running stale are three distinct answers", () => {
  const base = { port: 7331, urls: ["http://x.local:7331/"] };
  const notRunning = statusReport({ record: null, alive: false, installed: null, ...base, shimPath: "/s" });
  assert.equal(notRunning.state, "not-running");
  assert.equal(notRunning.exit, 1);
  assert.deepEqual(notRunning.lines, ["dashboard: not running"]);

  const startedMs = 1788825600000; // 2026-09-08T00:00:00Z
  const current = statusReport({
    record: { pid: 4321, port: 7331, version: "v1", startedMs },
    alive: true, installed: { version: "v1" }, ...base, shimPath: "/s",
  });
  assert.equal(current.state, "running");
  assert.equal(current.exit, 0);
  assert.ok(current.lines.some((l) => l.includes("pid 4321") && l.includes("2026-09-08 00:00:00")), current.lines.join("\n"));
  assert.ok(current.lines.some((l) => l.includes("version: v1")), current.lines.join("\n"));
  assert.ok(!current.lines.some((l) => /stale/.test(l)), "same version must not print stale");

  const stale = statusReport({
    record: { pid: 4321, port: 7331, version: "v1", startedMs: 1788825600000 },
    alive: true, installed: { version: "v2" }, ...base, shimPath: "/s",
  });
  assert.equal(stale.state, "stale", "a moved installed version is a third state, not 'running'");
  assert.equal(stale.exit, 0, "stale still serves; doctor is the verb that fails on it");
  assert.ok(stale.lines.some((l) => l.includes("stale") && l.includes("v1") && l.includes("v2")), stale.lines.join("\n"));
  assert.ok(stale.lines.some((l) => /serve restart/.test(l)), stale.lines.join("\n"));
});

test("doctor: all checks pass → exit 0; dead pid → named failure; cache-path launcher → named failure; unreadable firewall is unknown, never a failure", async () => {
  const dir = tmpHome();
  try {
    // a launcher that points at the shim, written the way install-autostart does
    installAutostart({ startupDir: dir, nodePath: "C:\\node\\node.exe", enginePath: "C:\\Users\\a\\.swarm\\serve.mjs",
      engineArgs: ["scripts/swarm.mjs", "serve", "--daemon"] });
    const good = { record: { pid: 4321, port: 7331, version: "v1", listening: true }, alive: true,
      installed: { version: "v1" }, port: 7331, startupDir: dir, shimPath: "C:\\Users\\a\\.swarm\\serve.mjs",
      _probePort: async () => ({ reachable: true }),
      _firewall: async () => ({ error: "access denied — elevation required" }) }; // firewall unreadable
    const pass = await doctorChecks(good);
    assert.equal(doctorExit(pass), 0, "unknown firewall must not fail the run");
    assert.equal(pass.find((c) => c.name === "firewall").status, "unknown");
    assert.equal(pass.find((c) => c.name === "version").status, "pass");

    const deadPid = await doctorChecks({ ...good, record: { pid: 4321, port: 7331, version: "v1" }, alive: false,
      _probePort: async () => ({ reachable: false }) });
    assert.equal(doctorExit(deadPid), 1);
    assert.equal(deadPid.find((c) => c.name === "pid").status, "fail", "the failing check must be named");
    assert.equal(deadPid.find((c) => c.name === "firewall").status, "unknown", "elevation is still not a failure");

    // a launcher pinned to the sha-versioned plugin cache — the silent-stale install
    installAutostart({ startupDir: dir, nodePath: "C:\\node\\node.exe",
      enginePath: "C:\\Users\\a\\.claude\\plugins\\cache\\andrewmaston1988-claude-plugins\\swarm\\0d6f126\\scripts\\swarm.mjs" });
    const mispointed = await doctorChecks(good);
    assert.equal(doctorExit(mispointed), 1);
    assert.equal(mispointed.find((c) => c.name === "autostart").status, "fail");
    assert.match(mispointed.find((c) => c.name === "autostart").detail, /install-autostart/);

    const versionDrift = await doctorChecks({ ...good, installed: { version: "v2" } });
    assert.equal(doctorExit(versionDrift), 1);
    assert.equal(versionDrift.find((c) => c.name === "version").status, "fail");
    assert.match(versionDrift.find((c) => c.name === "version").detail, /v1.*v2|v2.*v1/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("isAlive: uses signal 0, false on throw or no pid", () => {
  assert.equal(isAlive(null), false);
  assert.equal(isAlive(12, () => {}), true);
  assert.equal(isAlive(12, () => { throw new Error("ESRCH"); }), false);
});

test("urlLines: .local hostname first, then every non-internal IPv4; firewall hint names the port", () => {
  const lines = urlLines(7331, { host: "DESKTOP-X", ifaces: {
    lo: [{ family: "IPv4", address: "127.0.0.1", internal: true }],
    eth: [{ family: "IPv4", address: "192.168.1.20", internal: false }, { family: "IPv6", address: "fe80::1", internal: false }],
    wifi: [{ family: "IPv4", address: "10.0.0.5", internal: false }],
  } });
  assert.deepEqual(lines, ["http://desktop-x.local:7331/", "http://192.168.1.20:7331/", "http://10.0.0.5:7331/"]);
  assert.match(firewallHint(7331), /localport=7331/);
});

test("ensureShim: copies the resolver to the stable path so every launch goes through it", () => {
  const home = tmpHome();
  try {
    const p = ensureShim({ home, resolverSrc: RESOLVER_SRC });
    assert.equal(p, join(home, "serve.mjs"));
    assert.ok(existsSync(p));
    assert.equal(readFileSync(p, "utf8"), readFileSync(RESOLVER_SRC, "utf8"), "refreshed, not just created — a stale copy must not survive an update");
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test("daemon log: line JSON round trip; the size cap rotates exactly once; logging never throws", () => {
  const dir = tmpHome();
  try {
    const { log, path } = createLogger({ logDir: dir, maxBytes: 300 });
    log("serve", { msg: "listening" });
    log("serve", { msg: "a".repeat(200) });
    const rec = JSON.parse(readFileSync(path, "utf8").trim().split("\n")[0]);
    assert.equal(rec.event, "serve");
    assert.equal(rec.msg, "listening");
    assert.ok(rec.t, "each line carries a timestamp");
    log("serve", { msg: "c" }); // total now over the cap → this write rotates first
    assert.ok(existsSync(`${path}.1`), "one rotation: old content moves aside, it is not dropped or endlessly rotated");
    assert.ok(readFileSync(`${path}.1`, "utf8").includes("listening"), "the rotated file holds the old lines");
    assert.ok(readFileSync(path, "utf8").includes("\"msg\":\"c\""), "the live log starts fresh after the rotation");
    assert.ok(!readFileSync(path, "utf8").includes("listening"));

    // A logging failure must never take the daemon down: a directory sitting
    // where the log file should be makes every append throw — silently.
    mkdirSync(join(dir, "blocker"));
    createLogger({ logDir: dir, file: "blocker" }).log("x");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("autostart: install writes the launcher once (idempotent), uninstall removes it; no Startup dir → declines", () => {
  const dir = mkdtempSync(join(tmpdir(), "swarm-startup-"));
  try {
    const args = { startupDir: dir, nodePath: "C:\\node\\node.exe", enginePath: "C:\\p\\swarm.mjs" };
    const first = installAutostart(args);
    assert.equal(first.installed, true);
    assert.equal(first.changed, true);
    const body = readFileSync(launcherPath(dir), "utf8");
    assert.match(body, /serve --daemon/);
    assert.match(body, /"C:\\node\\node.exe"/);
    const second = installAutostart(args);
    assert.equal(second.changed, false, "same content → untouched");
    assert.equal(readdirSync(dir).length, 1);
    // The launcher must run whatever argv it is given, so the caller can point it at a
    // stable resolver shim instead of the sha-versioned plugin dir. Without this the
    // engine path is frozen at install time and every plugin update strands it.
    const shim = installAutostart({
      startupDir: dir,
      nodePath: "C:\\node\\node.exe",
      enginePath: "C:\\Users\\a\\.swarm\\serve.mjs",
      engineArgs: ["scripts/swarm.mjs", "serve", "--daemon"],
    });
    assert.equal(shim.changed, true, "different argv → rewritten");
    const shimBody = readFileSync(launcherPath(dir), "utf8");
    assert.match(shimBody, /"C:\\Users\\a\\\.swarm\\serve\.mjs" scripts\/swarm.mjs serve --daemon/);
    assert.ok(!/plugins[\\/]cache/.test(shimBody), "launcher must not embed the plugin cache path");

    assert.equal(uninstallAutostart({ startupDir: dir }).removed, true);
    assert.ok(!existsSync(launcherPath(dir)));
    assert.equal(uninstallAutostart({ startupDir: dir }).removed, false);
    assert.equal(installAutostart({ startupDir: null, nodePath: "n", enginePath: "e" }).installed, false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
// --- serve restart: never start a replacement while the old daemon lives ---
// The defect these guard (found in code review, 2026-09-09): restart signalled
// the old daemon, cleared its pid record immediately, and started a replacement
// without waiting. If the old process still held the port the replacement could
// not bind, its own record was cleared too, and once the old process finally
// exited ZERO daemons were listening — with the old one recordless in between,
// so `serve stop` could not reach it.

test("restartPlan: a daemon that ignores the signal aborts the restart and keeps its record", () => {
  const p = restartPlan({ record: { pid: 42 }, wasAlive: true, exited: false });
  assert.equal(p.act, "abort");
  assert.equal(p.clearRecord, false); // the live daemon must stay reachable by `serve stop`
});

test("restartPlan: a daemon that exits clears the record and starts the replacement", () => {
  const p = restartPlan({ record: { pid: 42 }, wasAlive: true, exited: true });
  assert.equal(p.act, "start");
  assert.equal(p.clearRecord, true);
});

test("restartPlan: no live daemon starts and clears the stale record", () => {
  assert.deepEqual(
    { act: "start", clear: restartPlan({ record: { pid: 42 }, wasAlive: false, exited: true }).clearRecord },
    { act: "start", clear: true },
  );
  assert.equal(restartPlan({ record: null, wasAlive: false, exited: true }).act, "start");
});

test("waitForExit: returns exited once the process is gone, not before", async () => {
  let calls = 0;
  const r = await waitForExit(7, {
    isAlive: () => ++calls < 3, // alive for two polls, then gone
    sleep: async () => {}, now: () => 0, deadlineMs: 1000,
  });
  assert.equal(r.exited, true);
  assert.equal(calls, 3);
});

test("waitForExit: a process that never dies reports not-exited rather than hanging", async () => {
  let t = 0;
  const r = await waitForExit(7, {
    isAlive: () => true, sleep: async () => { t += 100; }, now: () => t, deadlineMs: 300,
  });
  assert.equal(r.exited, false);
  assert.match(r.reason, /still alive/);
});
