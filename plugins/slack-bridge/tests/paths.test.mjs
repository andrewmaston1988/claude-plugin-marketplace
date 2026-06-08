import { test } from "node:test";
import assert from "node:assert/strict";
import { getPaths } from "../src/paths.mjs";

test("paths — all four dirs are non-empty strings", () => {
  const paths = getPaths();
  for (const key of ["configDir", "dataDir", "logDir", "stateDir"]) {
    assert.ok(typeof paths[key] === "string" && paths[key].length > 0, `${key} should be a non-empty string`);
  }
});

test("paths — all dirs include app name 'claude-slack'", () => {
  const paths = getPaths();
  for (const [key, val] of Object.entries(paths)) {
    assert.ok(val.includes("claude-slack"), `${key} should include 'claude-slack', got: ${val}`);
  }
});

test("paths — win32: configDir is under APPDATA", () => {
  if (process.platform !== "win32") return;
  const paths = getPaths();
  const appData = process.env.APPDATA;
  assert.ok(paths.configDir.startsWith(appData), `configDir should be under APPDATA, got: ${paths.configDir}`);
});

test("paths — darwin: configDir is under ~/Library/Application Support", () => {
  if (process.platform !== "darwin") return;
  const paths = getPaths();
  assert.ok(paths.configDir.includes("Library/Application Support"), `got: ${paths.configDir}`);
});

test("paths — linux: configDir is under ~/.config when no XDG set", () => {
  if (process.platform !== "linux") return;
  const orig = process.env.XDG_CONFIG_HOME;
  delete process.env.XDG_CONFIG_HOME;
  try {
    const paths = getPaths();
    assert.ok(paths.configDir.includes(".config"), `expected .config, got: ${paths.configDir}`);
  } finally {
    if (orig !== undefined) process.env.XDG_CONFIG_HOME = orig;
  }
});
