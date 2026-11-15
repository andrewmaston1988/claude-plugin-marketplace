// The Windows half of the tray's launch contract: tray.ps1 must parse, declare
// no parameter that shadows a read-only automatic variable, and declare every
// flag the daemon hands it.
//
// A parameter named after a read-only automatic variable (`-Home` vs `$HOME`) fails
// at binding — "Cannot overwrite variable Home because it is read-only or constant" —
// before a single line runs, so the tray never appeared and nothing said why.
//
// Its own file so the diff-aware Windows run always exercises it, not only when
// something in daemon.test.mjs's closure changed.
import "./helpers/isolate-home.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

test("tray.ps1: no parameter shadows a read-only PowerShell variable, and the daemon passes only declared ones", { skip: process.platform !== "win32" && "tray is Windows-only" }, () => {
  const tray = fileURLToPath(new URL("../src/serve/tray.ps1", import.meta.url));
  const probe = [
    "$errs = $null; $toks = $null",
    `$ast = [System.Management.Automation.Language.Parser]::ParseFile('${tray.replaceAll("'", "''")}', [ref]$toks, [ref]$errs)`,
    "$names = @($ast.ParamBlock.Parameters | ForEach-Object { $_.Name.VariablePath.UserPath })",
    "$locked = @(Get-Variable | Where-Object { $_.Options -match 'ReadOnly|Constant' } | ForEach-Object { $_.Name })",
    "@{ params = $names; clash = @($names | Where-Object { $locked -contains $_ }); parseErrors = $errs.Count } | ConvertTo-Json -Compress",
  ].join("\n");
  const r = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(probe, "utf16le").toString("base64")], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout.trim());
  assert.equal(out.parseErrors, 0, "tray.ps1 parses clean");
  assert.deepEqual([out.clash].flat(), [], `parameters shadowing read-only variables: ${out.clash}`);
  // Every -Flag the daemon hands the tray must be a parameter the tray declares.
  // The spawn lives in src/serve/tray.mjs — one module, because both the start path
  // and the DISABLED path launch it. From `-PidFile`, the first flag tray.ps1
  // declares: -WindowStyle and -NonInteractive ahead of it belong to powershell.exe.
  const trayMod = readFileSync(fileURLToPath(new URL("../src/serve/tray.mjs", import.meta.url)), "utf8");
  const from = trayMod.indexOf('"-PidFile"');
  assert.ok(from > 0, "found the tray argv array");
  const spawnArgs = trayMod.slice(from, trayMod.indexOf("];", from));
  assert.ok(spawnArgs.includes("-SwarmHome"), `the slice must reach the end of the tray flags: ${spawnArgs.slice(-60)}`);
  const passed = [...spawnArgs.matchAll(/"-(\w+)"/g)].map((m) => m[1].toLowerCase());
  const declared = [out.params].flat().map((p) => p.toLowerCase());
  assert.ok(passed.length >= 5, `found the tray spawn flags: ${passed}`);
  for (const p of passed) assert.ok(declared.includes(p), `swarm.mjs passes -${p}, which tray.ps1 does not declare`);
});
