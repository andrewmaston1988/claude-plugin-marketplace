import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { writePid, readPid, clearPid, isAlive, urlLines, firewallHint, installAutostart, uninstallAutostart, launcherPath } from "../src/serve/daemon.mjs";

test("pid: write/read/clear round-trip, atomic (no .tmp left), null on absent or corrupt", () => {
  const home = mkdtempSync(join(tmpdir(), "swarm-pid-"));
  try {
    assert.equal(readPid(home), null);
    writePid(home, 4321);
    assert.equal(readPid(home), 4321);
    assert.ok(!readdirSync(home).some((f) => f.endsWith(".tmp")));
    clearPid(home);
    assert.equal(readPid(home), null);
    clearPid(home); // idempotent
  } finally { rmSync(home, { recursive: true, force: true }); }
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
    assert.equal(uninstallAutostart({ startupDir: dir }).removed, true);
    assert.ok(!existsSync(launcherPath(dir)));
    assert.equal(uninstallAutostart({ startupDir: dir }).removed, false);
    assert.equal(installAutostart({ startupDir: null, nodePath: "n", enginePath: "e" }).installed, false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
