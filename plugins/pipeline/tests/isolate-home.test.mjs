import "./helpers/isolate-home.mjs";
import { test } from "node:test";
import { equal, ok } from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { homedir, tmpdir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";

const HELPER = fileURLToPath(new URL("./helpers/isolate-home.mjs", import.meta.url));

test("isolate-home: home resolves under tmpdir", () => {
  ok(homedir().startsWith(tmpdir()), `${homedir()} is not under ${tmpdir()}`);
  equal(process.env.HOME, homedir());
  equal(process.env.USERPROFILE, homedir());
});

test("isolate-home: marked, with no XDG dir left pointing at the real home", () => {
  equal(process.env.PIPELINE_TEST_HOME, "1");
  for (const k of ["XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_STATE_HOME", "XDG_CACHE_HOME"]) {
    equal(process.env[k], undefined, `${k} must be deleted`);
  }
});

// A hook spawn is the leak this helper exists to stop: a child that resolves a
// different home writes somewhere the parent's assertions cannot see.
test("isolate-home: a spawned child resolves the same home", () => {
  const r = spawnSync(process.execPath, ["-e", "console.log(require('os').homedir())"], {
    encoding: "utf8",
    env: process.env,
  });
  equal(r.stdout.trim(), homedir());
});

// A PIPELINE_TEST_HOME leaked into an operator's shell must not make the helper
// trust their real home: the marker licenses reuse only of a dir already under
// tmpdir(), so a real home gets replaced rather than written through.
test("isolate-home: a stray marker over a real home still gets a throwaway dir", () => {
  const real = resolve(tmpdir(), "..", "not-a-temp-home");
  const script = `import(${JSON.stringify(pathToFileURL(HELPER).href)}).then(() => console.log(process.env.HOME))`;
  const r = spawnSync(process.execPath, ["-e", script], {
    encoding: "utf8",
    env: { ...process.env, HOME: real, USERPROFILE: real, PIPELINE_TEST_HOME: "1" },
  });
  const childHome = r.stdout.trim();
  ok(childHome !== real && childHome.startsWith(tmpdir()), `child kept ${childHome}`);
});
