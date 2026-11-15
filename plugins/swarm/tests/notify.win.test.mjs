// The Windows half of the notifier: the real end-to-end console measurement.
//
// N5. Opt-in only. It spawns real processes and its control deliberately opens a
// console window, so running it on every suite put one on the operator's desktop
// each time. `SWARM_NOTIFY_CONSOLE_TEST=1` runs it; the unit rows in
// notify.test.mjs cover the shape in CI.
//
// It is written to be capable of failing: the control asserts the KNOWN-BAD options
// really do produce a visible console here, and the row skips rather than passes
// where the environment cannot tell the two states apart.
//
// Its own file so the diff-aware Windows run always exercises it, not only when
// something in notify.test.mjs's closure changed.
import "./helpers/isolate-home.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { windowsLaunchArgs } from "../src/notify.mjs";

const consoleRow = {
  skip: process.platform !== "win32" ? "windows-only console semantics"
    : process.env.SWARM_NOTIFY_CONSOLE_TEST !== "1" ? "opt-in: SWARM_NOTIFY_CONSOLE_TEST=1 (spawns real windows)"
    : false,
};

test("notify: the real launch leaves no visible console and still runs", consoleRow, async (t) => {
  const probe = fileURLToPath(new URL("./fixtures/report-console.ps1", import.meta.url));
  const dir = mkdtempSync(join(tmpdir(), "swarm-notify-"));
  const wait = async (out) => {
    for (let i = 0; i < 80 && !existsSync(out); i++) await setTimeout(250);
    return existsSync(out) ? readFileSync(out, "utf8").trim() : null;
  };

  const out = join(dir, "actual.txt");
  const line = `powershell -WindowStyle Hidden -NoProfile -ExecutionPolicy Bypass -File "${probe}" -Out "${out}"`;
  spawn("cmd.exe", windowsLaunchArgs(line), { detached: true, stdio: "ignore", windowsHide: true }).unref();
  const actual = await wait(out);

  assert.ok(actual !== null, "the notify launch must outlive this process and run the child");
  if (/hwnd=0 |visible=False/.test(actual)) return;

  const ctl = join(dir, "control.txt");
  spawn(`powershell -NoProfile -ExecutionPolicy Bypass -File "${probe}" -Out "${ctl}"`,
    { shell: true, detached: true, stdio: "ignore", windowsHide: true }).unref();
  const control = await wait(ctl);
  if (control === null || !control.includes("visible=True")) {
    return t.skip(`cannot distinguish console states here (control read ${control})`);
  }
  assert.fail(`notify launched a child owning a visible console (${actual})`);
});
