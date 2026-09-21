// TD1: the tray's pure decision functions (D4c/D4e). Windows-only — dot-sources
// tray-decide.ps1 and drives Get-TrayAction through a decision table via
// -EncodedCommand, the same pattern daemon.test.mjs uses for tray.ps1.
import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const TRAY_DECIDE = fileURLToPath(new URL("../src/serve/tray-decide.ps1", import.meta.url));
const SKIP = { skip: process.platform !== "win32" && "tray is Windows-only" };

function probe(lines) {
  const script = [`. '${TRAY_DECIDE.replaceAll("'", "''")}'`, ...lines].join("\n");
  const r = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  return JSON.parse(r.stdout.trim());
}

// The JSON round-trip is what makes an absent key distinguishable from `false`:
// the harness turns a missing property into $null, and $null is the "unreadable
// this tick" input, never "switched off".
function tableProbe(cases, call) {
  return [
    `$cases = '${JSON.stringify(cases).replaceAll("'", "''")}' | ConvertFrom-Json`,
    "$results = @()",
    "foreach ($c in $cases) {",
    "  $pidVal = $null",
    "  if ($null -ne $c.RecordPid) { $pidVal = [int]$c.RecordPid }",
    "  $onVal = $null",
    "  if ($null -ne $c.DashboardEnabled) { $onVal = [bool]$c.DashboardEnabled }",
    `  $results += [pscustomobject]@{ name = $c.name; action = ${call} }`,
    "}",
    "$results | ConvertTo-Json -Compress",
  ];
}

function byName(results) {
  return new Map(results.map((x) => [x.name, x.action]));
}

test("tray-decide.ps1: Get-TrayAction covers the poll decision table, including the handover self-heal", SKIP, () => {
  const cases = [
    { name: "record absent, streak >= 5 -> exit", RecordPid: null, Alive: false, Streak: 5, SamePid: false, RestartTimestamps: [], Now: 0, DashboardEnabled: true, DisabledSeed: false, expect: "exit" },
    { name: "record absent, streak < 5 -> none", RecordPid: null, Alive: false, Streak: 4, SamePid: false, RestartTimestamps: [], Now: 0, DashboardEnabled: true, DisabledSeed: false, expect: "none" },
    { name: "record present, alive -> none", RecordPid: 111, Alive: true, Streak: 5, SamePid: true, RestartTimestamps: [], Now: 1000000, DashboardEnabled: true, DisabledSeed: false, expect: "none" },
    { name: "record present, dead, pid changed mid-streak (handover self-heal) -> none", RecordPid: 222, Alive: false, Streak: 5, SamePid: false, RestartTimestamps: [], Now: 1000000, DashboardEnabled: true, DisabledSeed: false, expect: "none" },
    { name: "record present, dead, same pid, streak < 5 -> none", RecordPid: 111, Alive: false, Streak: 3, SamePid: true, RestartTimestamps: [], Now: 1000000, DashboardEnabled: true, DisabledSeed: false, expect: "none" },
    { name: "record present, dead, same pid, streak >= 5, 0 recent restarts -> restart", RecordPid: 111, Alive: false, Streak: 5, SamePid: true, RestartTimestamps: [], Now: 1000000, DashboardEnabled: true, DisabledSeed: false, expect: "restart" },
    { name: "record present, dead, same pid, streak >= 5, 3 restarts inside the 10-minute window -> crashed", RecordPid: 111, Alive: false, Streak: 5, SamePid: true, RestartTimestamps: [500000, 700000, 900000], Now: 1000000, DashboardEnabled: true, DisabledSeed: false, expect: "crashed" },
    { name: "record present, dead, same pid, streak >= 5, 3 restarts but all outside the 10-minute window -> restart", RecordPid: 111, Alive: false, Streak: 5, SamePid: true, RestartTimestamps: [1000, 2000, 3000], Now: 1000000, DashboardEnabled: true, DisabledSeed: false, expect: "restart" },
    // The dashboard switched off. The key is re-read on every tick, so what matters
    // is what the read says NOW, not what the spawn passed.
    // Without the disabled rows the absent-streak exit fires five polls after the
    // tray appears and the operator's only way back to enabled vanishes.
    { name: "disabled, record absent, streak >= 5 -> disabled, never exit", RecordPid: null, Alive: false, Streak: 5, SamePid: false, RestartTimestamps: [], Now: 0, DashboardEnabled: false, DisabledSeed: false, expect: "disabled" },
    { name: "disabled, record present but dead -> disabled, never restart", RecordPid: 111, Alive: false, Streak: 9, SamePid: true, RestartTimestamps: [], Now: 1000000, DashboardEnabled: false, DisabledSeed: false, expect: "disabled" },
    { name: "disabled with a daemon still serving -> disabled (the switch outranks the record)", RecordPid: 111, Alive: true, Streak: 0, SamePid: true, RestartTimestamps: [], Now: 1000000, DashboardEnabled: false, DisabledSeed: false, expect: "disabled" },
    // The tick's own read, against a spawn seed that disagrees — the out-of-band case.
    // `swarm serve enable` from another terminal writes the key and nothing else; the
    // surviving tray is the one-at-a-time guard's survivor, so the newcomer exits and
    // these reads are the ONLY thing that can move it.
    { name: "enabled on the tick after an out-of-band `serve enable`, absent record, streak >= 5 -> exit", RecordPid: null, Alive: false, Streak: 5, SamePid: false, RestartTimestamps: [], Now: 0, DashboardEnabled: true, DisabledSeed: true, expect: "exit" },
    { name: "enabled on the tick after an out-of-band `serve enable`, daemon alive -> none, not disabled", RecordPid: 111, Alive: true, Streak: 0, SamePid: true, RestartTimestamps: [], Now: 1000000, DashboardEnabled: true, DisabledSeed: true, expect: "none" },
    { name: "enabled on the tick after an out-of-band `serve enable`, daemon dead -> restart", RecordPid: 111, Alive: false, Streak: 5, SamePid: true, RestartTimestamps: [], Now: 1000000, DashboardEnabled: true, DisabledSeed: true, expect: "restart" },
    { name: "disabled on the tick after an out-of-band `serve disable` -> disabled, never restart", RecordPid: 111, Alive: false, Streak: 9, SamePid: true, RestartTimestamps: [], Now: 1000000, DashboardEnabled: false, DisabledSeed: true, expect: "disabled" },
    // An unreadable config is not an answer. The seed stands, so a file that is
    // missing or mid-write can never talk the tray out of its only way back on.
    { name: "config unreadable (null), spawn seeded disabled -> disabled, seed stands", RecordPid: null, Alive: false, Streak: 5, SamePid: false, RestartTimestamps: [], Now: 0, DashboardEnabled: null, DisabledSeed: true, expect: "disabled" },
    { name: "config unreadable (null), spawn seeded enabled -> the normal table applies", RecordPid: null, Alive: false, Streak: 5, SamePid: false, RestartTimestamps: [], Now: 0, DashboardEnabled: null, DisabledSeed: false, expect: "exit" },
  ];

  const results = probe(tableProbe(cases,
    "Get-TrayAction -RecordPid $pidVal -Alive $c.Alive -Streak $c.Streak -SamePid $c.SamePid -RestartTimestamps @($c.RestartTimestamps) -Now $c.Now -DashboardEnabled $onVal -DisabledSeed ([bool]$c.DisabledSeed)"));
  const got = byName(results);
  for (const c of cases) {
    assert.equal(got.get(c.name), c.expect, `${c.name}: expected ${c.expect}, got ${got.get(c.name)}`);
  }
});

// The menu is repainted from this, so it has to be the same resolution Get-TrayAction
// used — a second implementation in the poll loop is how Open/Restart go grey on a
// dashboard that is on.
test("tray-decide.ps1: Get-TrayDisabled resolves the off state from the tick's read, falling back to the seed", SKIP, () => {
  const cases = [
    { name: "key is true -> not disabled", DashboardEnabled: true, DisabledSeed: false, expect: false },
    { name: "key is true over a disabled seed -> not disabled", DashboardEnabled: true, DisabledSeed: true, expect: false },
    { name: "key is false -> disabled", DashboardEnabled: false, DisabledSeed: false, expect: true },
    { name: "key is false over an enabled seed -> disabled", DashboardEnabled: false, DisabledSeed: true, expect: true },
    { name: "key unreadable, seed disabled -> disabled", DashboardEnabled: null, DisabledSeed: true, expect: true },
    { name: "key unreadable, seed enabled -> not disabled", DashboardEnabled: null, DisabledSeed: false, expect: false },
  ];

  const results = probe(tableProbe(cases,
    "Get-TrayDisabled -DashboardEnabled $onVal -DisabledSeed ([bool]$c.DisabledSeed)"));
  const got = byName(results);
  for (const c of cases) {
    assert.equal(got.get(c.name), c.expect, `${c.name}: expected ${c.expect}, got ${got.get(c.name)}`);
  }
});
