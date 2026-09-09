// Test plan: repos/claude-plugin-marketplace/plans/swarm-cli-shim-test-plan.md
// Row 2 — the one that matters: the same installed command reaches a NEW
// engine after a sha bump, with no re-install. A shim that pins a sha has
// fixed nothing.
//
// Stated scoping: this fixture proves the installed wrapper re-resolves the
// registry on every invocation, so a sha bump in installed_plugins.json is
// picked up with nothing re-installed. It does NOT cover what a real
// `claude plugin update` also does — rewriting the cache contents and moving
// the install dir — that leg is the manual row's alone.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { runCli } from "./helpers/cli.mjs";

const KEY = "swarm@andrewmaston1988-claude-plugins";
const tmp = () => mkdtempSync(join(tmpdir(), "swarm-shabump-"));
const fakeHomeEnv = (home) => ({ HOME: home, USERPROFILE: home, SWARM_HOME: join(home, "swarm-home") });

// A registry-visible "install" whose bin/swarm.mjs prints a distinguishable marker.
function fixtureInstall(root, marker) {
  mkdirSync(join(root, "bin"), { recursive: true });
  writeFileSync(join(root, "bin", "swarm.mjs"), `#!/usr/bin/env node\nconsole.log(${JSON.stringify(marker)});\n`);
  return root;
}

const writeRegistry = (reg, entries) => {
  writeFileSync(reg, JSON.stringify({ plugins: { [KEY]: entries } }));
  return reg;
};

const runBashShim = (shimPath, env) =>
  spawnSync("bash", [shimPath], { encoding: "utf8", timeout: 30000, windowsHide: true, env: { ...process.env, ...env } });
const runCmdShim = (shimPath, env) =>
  spawnSync("cmd", ["/c", shimPath], { encoding: "utf8", timeout: 30000, windowsHide: true, env: { ...process.env, ...env } });

test("row 2: the identical installed wrapper reaches a NEW engine after a sha bump — no re-install, no re-copy", () => {
  const dir = tmp();
  try {
    const oldInstall = fixtureInstall(join(dir, "old"), "engine-OLD");
    const newInstall = fixtureInstall(join(dir, "new"), "engine-NEW");
    const home = join(dir, "home");
    mkdirSync(home);
    const r = runCli(["install"], { cwd: dir, env: fakeHomeEnv(home) });
    assert.equal(r.status, 0, r.stderr);
    const userBin = join(home, ".local", "bin");
    const bashShim = join(userBin, "swarm");
    const resolverCopy = join(userBin, "swarm-resolver.mjs");

    const reg = join(dir, "installed_plugins.json");
    writeRegistry(reg, [{ scope: "user", installPath: oldInstall, lastUpdated: "2026-09-08T00:00:00Z" }]);
    const first = runBashShim(bashShim, { SWARM_PLUGIN_REGISTRY: reg });
    assert.equal(first.status, 0, first.stderr);
    assert.ok(first.stdout.includes("engine-OLD"), `the wrapper must reach the registry's install: ${first.stdout}`);

    // The sha bump: ONLY the registry entry moves. The wrapper and the resolver
    // copy on disk are byte-identical before and after — no re-install happened.
    const bashBefore = readFileSync(bashShim);
    const resolverBefore = readFileSync(resolverCopy);
    writeRegistry(reg, [{ scope: "user", installPath: newInstall, lastUpdated: "2026-09-09T00:00:00Z" }]);
    assert.ok(readFileSync(bashShim).equals(bashBefore), "the wrapper file must be untouched");
    assert.ok(readFileSync(resolverCopy).equals(resolverBefore), "no re-copy of the resolver");

    // The IDENTICAL wrapper invocation, new registry.
    const second = runBashShim(bashShim, { SWARM_PLUGIN_REGISTRY: reg });
    assert.equal(second.status, 0, second.stderr);
    assert.ok(second.stdout.includes("engine-NEW"), `the same command must reach the new engine: ${second.stdout}`);
    assert.ok(!second.stdout.includes("engine-OLD"), "a shim still on the old install has fixed nothing — that is the defect this plan exists to kill");

    if (process.platform === "win32") {
      const viaCmd = runCmdShim(join(userBin, "swarm.cmd"), { SWARM_PLUGIN_REGISTRY: reg });
      assert.equal(viaCmd.status, 0, viaCmd.stderr);
      assert.ok(viaCmd.stdout.includes("engine-NEW"), `the .cmd wrapper is the real Windows PATH story: ${viaCmd.stdout}`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("row 2 (scope tie-break): a user-scope entry beats a newer non-user entry", () => {
  const dir = tmp();
  try {
    const userInstall = fixtureInstall(join(dir, "user-scoped"), "engine-USER");
    const projectInstall = fixtureInstall(join(dir, "project-scoped"), "engine-PROJECT");
    const home = join(dir, "home");
    mkdirSync(home);
    const r = runCli(["install"], { cwd: dir, env: fakeHomeEnv(home) });
    assert.equal(r.status, 0, r.stderr);
    const bashShim = join(home, ".local", "bin", "swarm");
    // the project entry is NEWER — the resolver's stated preference (user scope
    // first) is what the CLI now depends on, so pin it.
    const reg = writeRegistry(join(dir, "installed_plugins.json"), [
      { scope: "project", installPath: projectInstall, lastUpdated: "2026-09-10T00:00:00Z" },
      { scope: "user", installPath: userInstall, lastUpdated: "2026-09-01T00:00:00Z" },
    ]);
    const out = runBashShim(bashShim, { SWARM_PLUGIN_REGISTRY: reg });
    assert.equal(out.status, 0, out.stderr);
    assert.ok(out.stdout.includes("engine-USER"), `user scope must win over a newer non-user entry: ${out.stdout}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});