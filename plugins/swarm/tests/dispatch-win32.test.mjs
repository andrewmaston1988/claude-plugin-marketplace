// The Windows half of dispatch: turning argv into something CreateProcess will
// accept, and measuring the command line it produces. Split from dispatch.test.mjs
// at the seam its two section comments already marked.
import { test } from "node:test";
import { equal, deepEqual, throws } from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { toSpawnable, resolveExecutable, windowsCommandLineLength } from "../src/dispatch.mjs";

// ── windows spawn resolution ──────────────────────────────────────────────────

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

// An opaque .cmd cannot be peeled to a node script, and cmd.exe re-parses the argv it is
// handed — a prompt containing quotes comes out mangled. Refusing names what to fix instead.
test("toSpawnable refuses an opaque .cmd instead of routing it through cmd.exe", () => {
  const cmdPath = join(tmpdir(), "swarm-opaque-shim", "claude.cmd");
  const io = { _platform: "win32", _readFileSync: () => "@echo off\r\necho hello\r\n" };
  throws(
    () => toSpawnable([cmdPath, "-p", "hi"], io),
    (e) => e.message.includes(cmdPath) && /not a node shim/.test(e.message)
  );
  // An unreadable shim is no more peelable than an opaque one — same refusal, not a fallthrough.
  throws(
    () => toSpawnable([cmdPath, "-p", "hi"], { _platform: "win32", _readFileSync: () => { throw new Error("EACCES"); } }),
    (e) => e.message.includes(cmdPath) && /not a node shim/.test(e.message)
  );
});

test("toSpawnable passes .exe and pathless resolution through untouched", { skip: process.platform !== "win32" }, () => {
  const r = toSpawnable(["C:\\bin\\claude.exe", "-p", "x"]);
  equal(r.cmd, "C:\\bin\\claude.exe");
  deepEqual(r.args, ["-p", "x"]);
});

// ── windowsCommandLineLength (CreateProcess quoting) ───────────────────────────

test("windowsCommandLineLength: plain args join with single spaces, no quoting", () => {
  equal(windowsCommandLineLength(["claude", "-p", "hello", "--model", "claude-haiku-4-5-20251001"]), "claude -p hello --model claude-haiku-4-5-20251001".length);
});

test("windowsCommandLineLength: an arg with a space is wrapped in quotes", () => {
  equal(windowsCommandLineLength(["claude", "-p", "hello world"]), 'claude -p "hello world"'.length);
});

test("windowsCommandLineLength: quote characters double the cost (escaped, plus wrapping quotes)", () => {
  // a 4-char prompt of all quotes: each " becomes \" (2 chars), plus 2 wrapping quotes
  const len = windowsCommandLineLength(["claude", "-p", '""""']);
  // "claude -p " (10) + wrapping quote (1) + 4x(\") (8) + closing quote (1) = 20
  equal(len, 10 + 1 + 8 + 1);
});

test("windowsCommandLineLength: a trailing backslash before the closing quote is doubled", () => {
  // arg has a space (forces quoting) and ends in a backslash
  const len = windowsCommandLineLength(["claude", "-p", "a b\\"]);
  // quoted form: "a b\\" -> " a b \\ \\ " = 1 + 3 + 2 + 1 = 7, plus "claude -p " (10)
  equal(len, 10 + 7);
});

test("resolveExecutable resolves a bare name via where on win32", { skip: process.platform !== "win32" }, () => {
  const fakeWhere = (cmd, args) => ({ status: 0, stdout: "C:\\somewhere\\claude.cmd\r\nC:\\other\\claude.exe\r\n" });
  equal(resolveExecutable("claude", { _spawnSync: fakeWhere }), "C:\\somewhere\\claude.cmd");
  const missing = () => ({ status: 1, stdout: "" });
  equal(resolveExecutable("claude", { _spawnSync: missing }), "claude");
});
