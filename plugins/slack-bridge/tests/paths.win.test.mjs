// The Windows half of the path table: configDir must sit under APPDATA.
//
// Its own file so the diff-aware Windows run always exercises it, not only when
// something in paths.test.mjs's closure changed.
import { test } from "node:test";
import assert from "node:assert/strict";
import { getPaths } from "../src/paths.mjs";

test("paths — win32: configDir is under APPDATA", () => {
  if (process.platform !== "win32") return;
  const paths = getPaths();
  const appData = process.env.APPDATA;
  assert.ok(paths.configDir.startsWith(appData), `configDir should be under APPDATA, got: ${paths.configDir}`);
});
