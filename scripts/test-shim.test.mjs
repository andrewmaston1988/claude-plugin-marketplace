// The shim's install gate. Every row injects a fake fs and spawnSync: no real
// npm, no network, nothing on disk. Importing the shim must not install --
// if the entry-point guard misfired, these runs would execute a real `npm ci`.

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { ensureInstalled } from "./test.mjs";

const LOCK = "{ \"lockfileVersion\": 3 }";
const LOCKFILE = join(tmpdir(), "test-shim-fixture", "package-lock.json");
const ROOT = join(tmpdir(), "test-shim-fixture");

const PACKAGE = join(ROOT, "node_modules", "test-runner", "package.json");
const RECORD = join(ROOT, "node_modules", ".test-install-hash");

const hashOf = (bytes) => createHash("sha256").update(bytes).digest("hex");

/** An in-memory fs, keyed by the same absolute paths the shim builds. */
function fakeFs({ existing = [], contents = {}, unreadable = [], lockfile = true } = {}) {
  const files = new Map([...(lockfile ? [[LOCKFILE, LOCK]] : []), ...Object.entries(contents)]);
  for (const path of existing) if (!files.has(path)) files.set(path, "");
  const dirs = new Set();
  const writes = [];
  return {
    files,
    dirs,
    writes,
    existsSync: (path) => files.has(path) || dirs.has(path),
    readFileSync: (path) => {
      if (unreadable.includes(path)) throw new Error("EACCES");
      if (!files.has(path)) throw new Error(`ENOENT: ${path}`);
      return files.get(path);
    },
    mkdirSync: (path) => dirs.add(path),
    writeFileSync: (path, data) => {
      files.set(path, data);
      writes.push(path);
    },
  };
}

function fakeSpawn({ status = 0, error = null } = {}) {
  const calls = [];
  const spawn = (command, args, options) => {
    calls.push({ command, args, options });
    return { status, error, stdout: "", stderr: "" };
  };
  spawn.calls = calls;
  return spawn;
}

/** A root where the package is installed at the given lockfile hash. */
function installedRoot(hash) {
  return fakeFs({ existing: [PACKAGE], contents: { [RECORD]: `${hash}\n` } });
}

test("installs when the package is missing", () => {
  const fs = fakeFs();
  const spawn = fakeSpawn();
  const result = ensureInstalled({ root: ROOT, _fs: fs, _spawnSync: spawn, _platform: "linux", _env: {} });

  assert.deepEqual(result, { installed: true });
  assert.equal(spawn.calls.length, 1);
  assert.equal(spawn.calls[0].command, "npm");
  assert.deepEqual(spawn.calls[0].args, ["ci"]);
  assert.equal(spawn.calls[0].options.cwd, ROOT);
  assert.equal(spawn.calls[0].options.stdio, "inherit");
  assert.equal(fs.files.get(RECORD), hashOf(LOCK));
});

test("does not install when the package and the hash record both match", () => {
  const fs = installedRoot(hashOf(LOCK));
  const spawn = fakeSpawn();

  assert.deepEqual(ensureInstalled({ root: ROOT, _fs: fs, _spawnSync: spawn, _platform: "linux", _env: {} }), { installed: false });
  assert.equal(spawn.calls.length, 0);
});

test("installs when the record is absent or unreadable", () => {
  for (const fs of [
    fakeFs({ existing: [PACKAGE] }),
    fakeFs({ existing: [PACKAGE], unreadable: [RECORD] }),
  ]) {
    const spawn = fakeSpawn();
    assert.deepEqual(ensureInstalled({ root: ROOT, _fs: fs, _spawnSync: spawn, _platform: "linux", _env: {} }), { installed: true });
    assert.equal(spawn.calls.length, 1);
    assert.equal(fs.files.get(RECORD), hashOf(LOCK));
  }
});

test("installs again when the lockfile bytes change", () => {
  const fs = installedRoot(hashOf("{ \"lockfileVersion\": 2 }"));
  const spawn = fakeSpawn();

  assert.deepEqual(ensureInstalled({ root: ROOT, _fs: fs, _spawnSync: spawn, _platform: "linux", _env: {} }), { installed: true });
  assert.equal(spawn.calls.length, 1);
  assert.equal(fs.files.get(RECORD), hashOf(LOCK));
});

test("returns an error and writes no record when the install fails", () => {
  for (const outcome of [{ error: new Error("spawn npm ENOENT") }, { status: 1 }]) {
    const fs = fakeFs();
    const spawn = fakeSpawn(outcome);
    const result = ensureInstalled({ root: ROOT, _fs: fs, _spawnSync: spawn, _platform: "linux", _env: {} });

    assert.equal(result.installed, false);
    assert.equal(typeof result.error, "string");
    assert.equal(fs.writes.length, 0);
    assert.equal(fs.files.has(RECORD), false);
  }
});

test("CI=true skips the install gate, because the job already ran npm ci", () => {
  const fs = fakeFs(); // package missing, no hash record
  const spawn = fakeSpawn();

  assert.deepEqual(
    ensureInstalled({ root: ROOT, _fs: fs, _spawnSync: spawn, _platform: "linux", _env: { CI: "true" } }),
    { installed: false },
  );
  assert.equal(spawn.calls.length, 0);
  assert.equal(fs.writes.length, 0);
});

test("a missing root lockfile is an error, not a crash", () => {
  const fs = fakeFs({ lockfile: false });
  const spawn = fakeSpawn();

  assert.deepEqual(
    ensureInstalled({ root: ROOT, _fs: fs, _spawnSync: spawn, _platform: "linux", _env: {} }),
    { installed: false, error: `no package-lock.json at ${ROOT} — run npm install` },
  );
  assert.equal(spawn.calls.length, 0);
});

test("uses a shell on win32 only, passing one command string there", () => {
  const calls = [];
  for (const platform of ["win32", "linux"]) {
    const spawn = fakeSpawn();
    ensureInstalled({ root: ROOT, _fs: fakeFs(), _spawnSync: spawn, _platform: platform, _env: {} });
    calls.push(spawn.calls[0]);
  }
  assert.deepEqual(calls.map((call) => call.options.shell), [true, false]);
  assert.equal(calls[0].command, "npm ci");
  assert.deepEqual(calls[0].args, []);
  assert.equal(calls[1].command, "npm");
  assert.deepEqual(calls[1].args, ["ci"]);
});
