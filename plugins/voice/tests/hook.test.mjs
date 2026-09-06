import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { distil, buildPrompt } from "../src/distil.mjs";

const HOOK = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "hooks", "session-start.mjs");

function run(payload, home, envExtra = {}) {
  const env = { ...process.env, VOICE_HOME: home, ...envExtra };
  delete env.CLAUDE_VOICE; Object.assign(env, envExtra);
  try {
    return { code: 0, out: execFileSync(process.execPath, [HOOK], { input: JSON.stringify(payload), env, encoding: "utf8" }) };
  } catch (e) { return { code: e.status ?? 1, out: String(e.stdout || "") }; }
}

test("hook is silent without a profile, injects on startup, skips resume, honours kill switch", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "voice-hook-"));
  assert.deepEqual(run({ source: "startup" }, home), { code: 0, out: "" });
  fs.writeFileSync(path.join(home, "profile.md"), "# Operator profile\n- terse\n");
  const r = run({ source: "startup" }, home);
  assert.equal(r.code, 0);
  assert.match(r.out, /^<operator-profile v="1">\n# Operator profile\n- terse\n<\/operator-profile>\n$/);
  assert.equal(run({ source: "clear" }, home).out.length > 0, true);
  assert.equal(run({ source: "resume" }, home).out, "");
  assert.equal(run({ source: "compact" }, home).out, "");
  assert.equal(run({ source: "startup" }, home, { CLAUDE_VOICE: "off" }).out, "");
  assert.equal(run("not json", home).code, 0);
});

test("distil shells out once and validates the result shape", () => {
  const calls = [];
  const ok = distil("SAMPLE", { _spawn: (bin, a, o) => { calls.push([bin, a, o.input]); return { status: 0, stdout: "# Operator profile\n- x" }; } });
  assert.equal(ok, "# Operator profile\n- x");
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0][1], ["-p", "--model", "sonnet", "--output-format", "text"]);
  assert.equal(calls[0][2], buildPrompt("SAMPLE"));
  assert.throws(() => distil("S", { _spawn: () => ({ status: 1, stderr: "boom" }) }), /exited 1: boom/);
  // first spawn fails to start → falls back to cmd.exe on win32, errors elsewhere
  const seq = [];
  const fallback = (bin, a) => { seq.push(bin); return seq.length === 1 ? { error: new Error("ENOENT") } : { status: 0, stdout: "# Operator profile\n- y" }; };
  if (process.platform === "win32") {
    assert.equal(distil("S", { _spawn: fallback }), "# Operator profile\n- y");
    assert.deepEqual(seq, ["claude", "cmd.exe"]);
  } else {
    assert.throws(() => distil("S", { _spawn: fallback }), /failed to start/);
  }
  assert.throws(() => distil("S", { _spawn: () => ({ status: 0, stdout: "Sure! Here is" }) }), /not an operator profile/);
});
