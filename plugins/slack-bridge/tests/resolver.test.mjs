import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveInstallPath } from "../bin/claude-slack-resolver.mjs";

test("resolveInstallPath: finds the plugin across any marketplace key", () => {
  const registry = { plugins: {
    "slack-bridge@some-marketplace": [{ scope: "user", installPath: "C:/cache/sb/abc123", lastUpdated: "2026-07-01" }],
    "other@some-marketplace": [{ scope: "user", installPath: "C:/cache/o/x" }],
  } };
  assert.equal(resolveInstallPath(registry), "C:/cache/sb/abc123");
});

test("resolveInstallPath: prefers user scope and latest update", () => {
  const registry = { plugins: {
    "slack-bridge@m": [
      { scope: "project", installPath: "C:/cache/sb/proj", lastUpdated: "2026-07-07" },
      { scope: "user", installPath: "C:/cache/sb/old", lastUpdated: "2026-06-01" },
      { scope: "user", installPath: "C:/cache/sb/new", lastUpdated: "2026-07-05" },
    ],
  } };
  assert.equal(resolveInstallPath(registry), "C:/cache/sb/new");
});

test("resolveInstallPath: null when absent or malformed", () => {
  assert.equal(resolveInstallPath({ plugins: {} }), null);
  assert.equal(resolveInstallPath({}), null);
  assert.equal(resolveInstallPath(null), null);
});
