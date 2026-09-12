// TD1: the tray's pure decision function (D4c). Windows-only — dot-sources
// tray-decide.ps1 and drives Get-TrayAction through a decision table via
// -EncodedCommand, the same pattern daemon.test.mjs uses for tray.ps1.
import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const TRAY_DECIDE = fileURLToPath(new URL("../src/serve/tray-decide.ps1", import.meta.url));

test("tray-decide.ps1: Get-TrayAction covers the poll decision table, including the handover self-heal", { skip: process.platform !== "win32" && "tray is Windows-only" }, () => {
  const cases = [
    { name: "record absent, streak >= 5 -> exit", RecordPid: null, Alive: false, Streak: 5, SamePid: false, RestartTimestamps: [], Now: 0, expect: "exit" },
    { name: "record absent, streak < 5 -> none", RecordPid: null, Alive: false, Streak: 4, SamePid: false, RestartTimestamps: [], Now: 0, expect: "none" },
    { name: "record present, alive -> none", RecordPid: 111, Alive: true, Streak: 5, SamePid: true, RestartTimestamps: [], Now: 1000000, expect: "none" },
    { name: "record present, dead, pid changed mid-streak (handover self-heal) -> none", RecordPid: 222, Alive: false, Streak: 5, SamePid: false, RestartTimestamps: [], Now: 1000000, expect: "none" },
    { name: "record present, dead, same pid, streak < 5 -> none", RecordPid: 111, Alive: false, Streak: 3, SamePid: true, RestartTimestamps: [], Now: 1000000, expect: "none" },
    { name: "record present, dead, same pid, streak >= 5, 0 recent restarts -> restart", RecordPid: 111, Alive: false, Streak: 5, SamePid: true, RestartTimestamps: [], Now: 1000000, expect: "restart" },
    { name: "record present, dead, same pid, streak >= 5, 3 restarts inside the 10-minute window -> crashed", RecordPid: 111, Alive: false, Streak: 5, SamePid: true, RestartTimestamps: [500000, 700000, 900000], Now: 1000000, expect: "crashed" },
    { name: "record present, dead, same pid, streak >= 5, 3 restarts but all outside the 10-minute window -> restart", RecordPid: 111, Alive: false, Streak: 5, SamePid: true, RestartTimestamps: [1000, 2000, 3000], Now: 1000000, expect: "restart" },
  ];

  const probe = [
    `. '${TRAY_DECIDE.replaceAll("'", "''")}'`,
    `$cases = '${JSON.stringify(cases).replaceAll("'", "''")}' | ConvertFrom-Json`,
    "$results = @()",
    "foreach ($c in $cases) {",
    "  $pidVal = $null",
    "  if ($null -ne $c.RecordPid) { $pidVal = [int]$c.RecordPid }",
    "  $action = Get-TrayAction -RecordPid $pidVal -Alive $c.Alive -Streak $c.Streak -SamePid $c.SamePid -RestartTimestamps @($c.RestartTimestamps) -Now $c.Now",
    "  $results += [pscustomobject]@{ name = $c.name; action = $action }",
    "}",
    "$results | ConvertTo-Json -Compress",
  ].join("\n");

  const r = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(probe, "utf16le").toString("base64")], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  const results = JSON.parse(r.stdout.trim());
  const byName = new Map(results.map((x) => [x.name, x.action]));
  for (const c of cases) {
    assert.equal(byName.get(c.name), c.expect, `${c.name}: expected ${c.expect}, got ${byName.get(c.name)}`);
  }
});
