import { test } from "node:test";
import { equal } from "node:assert/strict";
import { homedir } from "node:os";
import { join } from "node:path";

// Stub platform + bust ESM cache to re-evaluate paths.mjs per call.
async function loadPathsAs(platform, env = {}) {
  const orig = process.platform;
  Object.defineProperty(process, "platform", { value: platform, configurable: true });
  const savedEnv = { ...process.env };
  for (const k of ["XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_STATE_HOME"]) delete process.env[k];
  Object.assign(process.env, env);
  try {
    const mod = await import(`../src/paths.mjs?cb=${platform}-${Math.random().toString(36).slice(2)}`);
    return mod.getPaths();
  } finally {
    Object.defineProperty(process, "platform", { value: orig, configurable: true });
    process.env = savedEnv;
  }
}

test("paths: macOS uses ~/.pipeline (unchanged)", async () => {
  const p = await loadPathsAs("darwin");
  equal(p.configDir, join(homedir(), ".pipeline"));
  equal(p.dataDir,   join(homedir(), ".pipeline"));
  equal(p.stateDir,  join(homedir(), ".pipeline"));
  equal(p.logDir,    join(homedir(), ".pipeline", "logs"));
});

test("paths: Windows uses ~/.pipeline (unchanged)", async () => {
  const p = await loadPathsAs("win32");
  equal(p.configDir, join(homedir(), ".pipeline"));
  equal(p.logDir,    join(homedir(), ".pipeline", "logs"));
});

test("paths: Linux falls back to XDG defaults when env unset", async () => {
  const p = await loadPathsAs("linux");
  equal(p.configDir, join(homedir(), ".config",      "pipeline"));
  equal(p.dataDir,   join(homedir(), ".local", "share", "pipeline"));
  equal(p.stateDir,  join(homedir(), ".local", "state", "pipeline"));
  equal(p.logDir,    join(homedir(), ".local", "state", "pipeline", "logs"));
});

test("paths: Linux honours XDG_CONFIG_HOME / XDG_DATA_HOME / XDG_STATE_HOME", async () => {
  const p = await loadPathsAs("linux", {
    XDG_CONFIG_HOME: "/custom/cfg",
    XDG_DATA_HOME:   "/custom/data",
    XDG_STATE_HOME:  "/custom/state",
  });
  equal(p.configDir, join("/custom/cfg",   "pipeline"));
  equal(p.dataDir,   join("/custom/data",  "pipeline"));
  equal(p.stateDir,  join("/custom/state", "pipeline"));
  equal(p.logDir,    join("/custom/state", "pipeline", "logs"));
});
