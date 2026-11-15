// The win32 half of spawn resolution: a real `.cmd` shim is peeled to the node
// script it names, `.exe` passes through untouched, and a bare name resolves via
// `where`.
//
// Its own file so the diff-aware Windows run always exercises it, not only when
// something in dispatch.test.mjs's closure changed.
import "./helpers/isolate-home.mjs";
import { test } from "node:test";
import { equal, deepEqual } from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { toSpawnable, resolveExecutable } from "../src/dispatch.mjs";

test("toSpawnable peels a node .cmd shim, expanding %~dp0", { skip: process.platform !== "win32" }, () => {
  const dir = mkdtempSync(join(tmpdir(), "swarm-shim-"));
  try {
    const cmdPath = join(dir, "claude.cmd");
    writeFileSync(cmdPath, `@echo off\r\nnode "%~dp0claude-shim.mjs" %*\r\n`);
    const { cmd, args } = toSpawnable([cmdPath, "-p", "hi"]);
    equal(cmd, process.execPath);
    equal(args[0], join(dir, "claude-shim.mjs"));
    deepEqual(args.slice(1), ["-p", "hi"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("toSpawnable passes .exe and pathless resolution through untouched", { skip: process.platform !== "win32" }, () => {
  const r = toSpawnable(["C:\\bin\\claude.exe", "-p", "x"]);
  equal(r.cmd, "C:\\bin\\claude.exe");
  deepEqual(r.args, ["-p", "x"]);
});

test("resolveExecutable resolves a bare name via where on win32", { skip: process.platform !== "win32" }, () => {
  const fakeWhere = (cmd, args) => ({ status: 0, stdout: "C:\\somewhere\\claude.cmd\r\nC:\\other\\claude.exe\r\n" });
  equal(resolveExecutable("claude", { _spawnSync: fakeWhere }), "C:\\somewhere\\claude.cmd");
  const missing = () => ({ status: 1, stdout: "" });
  equal(resolveExecutable("claude", { _spawnSync: missing }), "claude");
});
