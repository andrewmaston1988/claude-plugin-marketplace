// The notifier's real console measurement, Windows only and opt-in
// (`SWARM_NOTIFY_CONSOLE_TEST=1`): its control opens a visible console window.
// The control asserts the known-bad options really do show one, and the row skips
// where the environment cannot tell the two states apart.
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
