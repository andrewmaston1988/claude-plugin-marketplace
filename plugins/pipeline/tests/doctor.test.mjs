// pipeline doctor — 11 checks, tristate output, exit-code policy.
//
// Focused per-check tests rather than end-to-end, so test results don't depend
// on the host's `claude` CLI presence.
import { test } from "node:test";
import { equal, ok, match, deepEqual } from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runDoctor, printDoctor, doctorExitCode, parseNetstatPids, parseTasklist, parseWmicCommandLine, parseCimCommandLine, detectPortOccupant } from "../src/setup/doctor.mjs";
import { connectUnified, close } from "../src/db/connection.mjs";
import { projectAdd } from "../src/db/projects.mjs";

function freshPaths() {
  const tmp = mkdtempSync(join(tmpdir(), "pipeline-doctor-"));
  return {
    tmp,
    paths: { stateDir: join(tmp, "state"), dataDir: join(tmp, "data") },
    cfgPath: join(tmp, "config.json"),
  };
}

function cleanup(tmp) {
  rmSync(tmp, { recursive: true, force: true });
}

function findCheck(results, label) {
  return results.find(r => r.label === label) ?? null;
}

test("doctor: returns exactly 21 results", async () => {
  // 15 prior checks + worktree-layout-stale + web-port-conflict + governor-env-contract + zombie-rows-check + concurrency-scope + max-concurrent.
  const { tmp, paths, cfgPath } = freshPaths();
  try {
    const results = await runDoctor({ paths, configPath: cfgPath });
    equal(results.length, 21);
  } finally { cleanup(tmp); }
});

test("doctor: fresh install — DB absent, config absent → warns (not fails)", async () => {
  const { tmp, paths, cfgPath } = freshPaths();
  try {
    const results = await runDoctor({ paths, configPath: cfgPath });
    const db     = findCheck(results, "pipeline DB readable");
    const cfg    = findCheck(results, "config.json parseable");
    const slack  = findCheck(results, "Governance channel set");
    const proj   = findCheck(results, "at least one project");
    ok(db && !db.ok && db.warn, "DB check should warn");
    ok(cfg && !cfg.ok && cfg.warn, "config check should warn");
    ok(slack && !slack.ok && slack.warn, "Slack channel should warn (null default)");
    ok(proj && !proj.ok && proj.warn, "project count should warn (zero)");
  } finally { cleanup(tmp); }
});

test("doctor: malformed config.json → check 6 fails (exit 1)", async () => {
  const { tmp, paths, cfgPath } = freshPaths();
  try {
    writeFileSync(cfgPath, "{ not valid json", "utf8");
    const results = await runDoctor({ paths, configPath: cfgPath });
    const cfg = findCheck(results, "config.json parseable");
    ok(cfg && !cfg.ok && !cfg.warn, "config check should hard-fail");
    match(cfg.detail, /malformed/);
    equal(doctorExitCode(results), 1);
  } finally { cleanup(tmp); }
});

test("doctor: registered project at non-existent path → check 11 fails", async () => {
  const { tmp, paths, cfgPath } = freshPaths();
  try {
    const repoRoot = join(tmp, "ghostproj");
    mkdirSync(join(repoRoot, ".git"), { recursive: true });
    mkdirSync(paths.dataDir, { recursive: true });
    const db = connectUnified(paths);
    try {
      // Validation requires the path to exist at add-time. Add it, then
      // remove the directory underneath the registry to simulate a project
      // that was deleted/moved after registration.
      projectAdd(db, { name: "ghostproj", rootPath: repoRoot });
      rmSync(repoRoot, { recursive: true, force: true });
      const results = await runDoctor({ paths, configPath: cfgPath, db });
      const projPathsCheck = findCheck(results, "registered project paths");
      ok(projPathsCheck && !projPathsCheck.ok && !projPathsCheck.warn);
      match(projPathsCheck.detail, /not found/);
      equal(doctorExitCode(results), 1);
    } finally { close(db); }
  } finally { cleanup(tmp); }
});

test("doctor: registered project pointing at valid git repo → check 11 passes", async () => {
  const { tmp, paths, cfgPath } = freshPaths();
  try {
    const repoRoot = join(tmp, "myrepo");
    mkdirSync(join(repoRoot, ".git"), { recursive: true });
    mkdirSync(paths.dataDir, { recursive: true });
    const db = connectUnified(paths);
    try {
      projectAdd(db, { name: "myrepo", rootPath: repoRoot });
      const results = await runDoctor({ paths, configPath: cfgPath, db });
      const projPathsCheck = findCheck(results, "registered project paths");
      const projCountCheck = findCheck(results, "at least one project");
      ok(projPathsCheck && projPathsCheck.ok);
      ok(projCountCheck && projCountCheck.ok);
    } finally { close(db); }
  } finally { cleanup(tmp); }
});

test("doctor: Governance channel set + CLAUDE_SLACK_PLUGIN missing file → check 8 warns", async () => {
  const { tmp, paths, cfgPath } = freshPaths();
  const orig = process.env.CLAUDE_SLACK_PLUGIN;
  try {
    writeFileSync(cfgPath, JSON.stringify({ notifications: { slack_channel: "team-x" } }), "utf8");
    process.env.CLAUDE_SLACK_PLUGIN = join(tmp, "missing-plugin.mjs");
    const results = await runDoctor({ paths, configPath: cfgPath });
    const slack  = findCheck(results, "Governance channel set");
    const handler = findCheck(results, "claude-slack-plugin");
    ok(slack && slack.ok, "Slack channel should pass");
    ok(handler && !handler.ok && handler.warn, "claude-slack should warn (missing file)");
    match(handler.detail, /file missing/);
  } finally {
    if (orig === undefined) delete process.env.CLAUDE_SLACK_PLUGIN;
    else process.env.CLAUDE_SLACK_PLUGIN = orig;
    cleanup(tmp);
  }
});

test("doctor: Slack disabled → check 8 skipped (warns 'skipped — no Slack channel')", async () => {
  const { tmp, paths, cfgPath } = freshPaths();
  try {
    // No config → null slack_channel → check 8 should report 'skipped'
    const results = await runDoctor({ paths, configPath: cfgPath });
    const handler = findCheck(results, "claude-slack-plugin");
    ok(handler && !handler.ok && handler.warn);
    match(handler.detail, /skipped/);
  } finally { cleanup(tmp); }
});

test("doctorExitCode: warns only → 0", () => {
  const r = [
    { label: "a", ok: true,  warn: false, detail: "" },
    { label: "b", ok: false, warn: true,  detail: "" },
  ];
  equal(doctorExitCode(r), 0);
});

test("doctorExitCode: any hard fail → 1", () => {
  const r = [
    { label: "a", ok: true,  warn: false, detail: "" },
    { label: "b", ok: false, warn: false, detail: "" },
  ];
  equal(doctorExitCode(r), 1);
});

test("printDoctor: tristate icons match", () => {
  const calls = [];
  const origWrite = process.stdout.write.bind(process.stdout);
  process.stdout.write = (s) => { calls.push(s); return true; };
  try {
    printDoctor([
      { label: "alpha", ok: true,  warn: false, detail: "ok" },
      { label: "beta",  ok: false, warn: true,  detail: "warn" },
      { label: "gamma", ok: false, warn: false, detail: "fail" },
    ]);
  } finally {
    process.stdout.write = origWrite;
  }
  const out = calls.join("");
  match(out, /^✓ alpha: ok$/m);
  match(out, /^⚠ beta: warn$/m);
  match(out, /^✗ gamma: fail$/m);
});

test("doctor: paths missing throws clear error", async () => {
  try {
    await runDoctor({});
    throw new Error("expected throw");
  } catch (e) {
    match(e.message, /paths is required/);
  }
});

// BLOCKER 3 — governor-env-contract must use resolveTemplate so the doctor
// and the runtime agree on path resolution. A templated path like
// "{project}/templates/governor.md" must be resolved via the same function
// the runtime uses, not a bespoke ~/ / absolute / ~/.pipeline ternary.
test("doctor: governor-env-contract reads templated template_path", async () => {
  const { tmp, paths, cfgPath } = freshPaths();
  try {
    // Write a config that enables the governor with an absolute template_path
    // pointing at a real file containing a CONTRACT-known var. The check
    // passes when the doctor resolves the path AND the template's $VAR refs
    // match the spawn contract — proving the new resolveTemplate path is
    // wired in end-to-end.
    const tplDir = join(tmp, "templates");
    mkdirSync(tplDir, { recursive: true });
    const tplPath = join(tplDir, "governor.md");
    writeFileSync(tplPath, "governor for $CORRELATION_ID\n", "utf8");
    writeFileSync(cfgPath, JSON.stringify({
      governor: {
        enabled: true,
        template_path: tplPath,
      },
    }), "utf8");
    const results = await runDoctor({ paths, configPath: cfgPath });
    const gov = findCheck(results, "governor-env-contract");
    ok(gov, "governor-env-contract check should exist");
    equal(gov.ok, true);
  } finally { cleanup(tmp); }
});

// BLOCKER 3 (negative) — the doctor must read the template file (via the
// resolveTemplate path) and surface a warn when the template references vars
// not in the spawn contract. The old three-shape ternary missed this because
// existsSync returned false on the unsubstituted string and `unknown=[]`
// passed vacuously. The new resolveTemplate path resolves the template file
// first, so an unknown $VAR in the file is now visible.
test("doctor: governor-env-contract warns when template references unknown $VAR", async () => {
  const { tmp, paths, cfgPath } = freshPaths();
  try {
    const tplDir = join(tmp, "templates");
    mkdirSync(tplDir, { recursive: true });
    const tplPath = join(tplDir, "governor.md");
    // $BOGUS_VAR is not in the spawn contract — doctor must warn.
    writeFileSync(tplPath, "governor for $BOGUS_VAR\n", "utf8");
    writeFileSync(cfgPath, JSON.stringify({
      governor: {
        enabled: true,
        template_path: tplPath,
      },
    }), "utf8");
    const results = await runDoctor({ paths, configPath: cfgPath });
    const gov = findCheck(results, "governor-env-contract");
    ok(gov, "governor-env-contract check should exist");
    equal(gov.ok, false);
    equal(gov.warn, true);
    match(gov.detail, /BOGUS_VAR/);
  } finally { cleanup(tmp); }
});

// --- web-port-conflict helpers (Windows PID → process name) --------------------

const NETSTAT_PORT_OCCUPIED = [
  "Active Connections",
  "",
  "  Proto  Local Address          Foreign Address        State           PID",
  "  TCP    0.0.0.0:8765           0.0.0.0:0              LISTENING       1234",
  "  TCP    [::]:8765              [::]:0                 LISTENING       5678",
  "  TCP    0.0.0.0:80             0.0.0.0:0              LISTENING       9999",
  "",
].join("\r\n");

const NETSTAT_PORT_FREE = [
  "Active Connections",
  "",
  "  Proto  Local Address          Foreign Address        State           PID",
  "  TCP    0.0.0.0:9999           0.0.0.0:0              LISTENING       4321",
  "",
].join("\r\n");

const TASKLIST_PLAIN = [
  '"node.exe","1234","Console","1","12,345 K"',
  '"cmd.exe","5678","Console","1","2,000 K"',
  '"chrome.exe","9999","Console","1","80,000 K"',
].join("\r\n");

const WMIC_PIPELINE_CMDLINE = [
  "CommandLine",
  '"C:\\Program Files\\nodejs\\node.exe" "C:\\code\\claude-plugin-marketplace\\plugins\\pipeline\\bin\\pipeline.mjs" dashboard web',
  "",
].join("\r\n");

const WMIC_OTHER_NODE_CMDLINE = [
  "CommandLine",
  '"C:\\Program Files\\nodejs\\node.exe" "C:\\Users\\Andrew\\Documents\\some-script.js"',
  "",
].join("\r\n");

// PowerShell's Get-CimInstance emits one line per object: "CommandLine : ...".
const CIM_PIPELINE_CMDLINE = "CommandLine : \"C:\\Program Files\\nodejs\\node.exe\" \"C:\\code\\claude-plugin-marketplace\\plugins\\pipeline\\bin\\pipeline.mjs\" dashboard web";

const CIM_OTHER_NODE_CMDLINE = "CommandLine : \"C:\\Program Files\\nodejs\\node.exe\" \"C:\\Users\\Andrew\\Documents\\some-script.js\"";

/** Stub a `run` function that returns canned output keyed by command+args. */
function fakeRunner(scripts) {
  const calls = [];
  return {
    calls,
    run(cmd, args /*, opts */) {
      calls.push({ cmd, args });
      const key = `${cmd} ${args[0]}`;
      const script = scripts[key];
      if (!script) return { status: 0, stdout: "", stderr: "" };
      const step = script.shift();
      if (step && step.__throw) throw new Error("simulated");
      return step ?? { status: 0, stdout: "", stderr: "" };
    },
  };
}

test("parseNetstatPids: extracts LISTENING PIDs for the target port", () => {
  const pids = parseNetstatPids(NETSTAT_PORT_OCCUPIED, 8765);
  deepEqual(pids.sort(), ["1234", "5678"]);
});

test("parseNetstatPids: ignores other ports and non-LISTENING rows", () => {
  const pids = parseNetstatPids(NETSTAT_PORT_OCCUPIED, 80);
  deepEqual(pids, ["9999"]);
});

test("parseNetstatPids: empty input → empty list", () => {
  deepEqual(parseNetstatPids("", 8765), []);
  deepEqual(parseNetstatPids(null, 8765), []);
  deepEqual(parseNetstatPids(NETSTAT_PORT_OCCUPIED, 0), []);
});

test("parseTasklist: builds PID → image name map from CSV rows", () => {
  const map = parseTasklist(TASKLIST_PLAIN);
  equal(map.size, 3);
  equal(map.get("1234"), "node.exe");
  equal(map.get("5678"), "cmd.exe");
  equal(map.get("9999"), "chrome.exe");
});

test("parseTasklist: empty input → empty map", () => {
  equal(parseTasklist("").size, 0);
  equal(parseTasklist(null).size, 0);
});

test("parseWmicCommandLine: strips header and trims", () => {
  equal(parseWmicCommandLine(WMIC_PIPELINE_CMDLINE),
    '"C:\\Program Files\\nodejs\\node.exe" "C:\\code\\claude-plugin-marketplace\\plugins\\pipeline\\bin\\pipeline.mjs" dashboard web');
});

test("parseWmicCommandLine: empty input → empty string", () => {
  equal(parseWmicCommandLine(""), "");
  equal(parseWmicCommandLine(null), "");
});

test("parseCimCommandLine: extracts the CommandLine value", () => {
  equal(parseCimCommandLine(CIM_PIPELINE_CMDLINE),
    '"C:\\Program Files\\nodejs\\node.exe" "C:\\code\\claude-plugin-marketplace\\plugins\\pipeline\\bin\\pipeline.mjs" dashboard web');
});

test("parseCimCommandLine: empty input → empty string", () => {
  equal(parseCimCommandLine(""), "");
  equal(parseCimCommandLine(null), "");
});

test("parseCimCommandLine: no CommandLine line → empty string", () => {
  equal(parseCimCommandLine("ProcessId : 1234\nName : node.exe"), "");
});

test("detectPortOccupant (win32): port free → not in use, not ours", () => {
  const f = fakeRunner({
    "cmd /c": [{ status: 0, stdout: NETSTAT_PORT_FREE, stderr: "" }],
    "tasklist /FO": [{ status: 0, stdout: TASKLIST_PLAIN, stderr: "" }],
    "powershell -NoProfile": [{ status: 0, stdout: CIM_PIPELINE_CMDLINE, stderr: "" }],
  });
  const verdict = detectPortOccupant({ port: 8765, run: f.run, platform: "win32" });
  equal(verdict.inUse, false);
  equal(verdict.ours, false);
});

test("detectPortOccupant (win32): port held by node.exe running pipeline.mjs → ours", () => {
  const f = fakeRunner({
    "cmd /c": [{ status: 0, stdout: NETSTAT_PORT_OCCUPIED, stderr: "" }],
    "tasklist /FO": [{ status: 0, stdout: TASKLIST_PLAIN, stderr: "" }],
    "powershell -NoProfile": [{ status: 0, stdout: CIM_PIPELINE_CMDLINE, stderr: "" }],
  });
  const verdict = detectPortOccupant({ port: 8765, run: f.run, platform: "win32" });
  equal(verdict.inUse, true);
  equal(verdict.ours, true);
  // Only the node.exe PID should have triggered a PowerShell probe.
  equal(f.calls.filter(c => c.cmd === "powershell").length, 1);
  // args[3] is the -Command script body — must include ProcessId=1234.
  // args[2] is the "-Command" flag itself.
  match(f.calls.find(c => c.cmd === "powershell").args[3], /ProcessId=1234/);
});

test("detectPortOccupant (win32): port held by non-node process → not ours", () => {
  // 5678 = cmd.exe, 1234 = node.exe running something else.
  const f = fakeRunner({
    "cmd /c": [{ status: 0, stdout: NETSTAT_PORT_OCCUPIED, stderr: "" }],
    "tasklist /FO": [{ status: 0, stdout: TASKLIST_PLAIN, stderr: "" }],
    "powershell -NoProfile": [{ status: 0, stdout: CIM_OTHER_NODE_CMDLINE, stderr: "" }],
  });
  const verdict = detectPortOccupant({ port: 8765, run: f.run, platform: "win32" });
  equal(verdict.inUse, true);
  equal(verdict.ours, false);
  // Both node.exe and cmd.exe PIDs are seen; PowerShell probe only fires for node.exe.
  // (cmd.exe PID 5678 is not a node.exe, so PowerShell is called once for PID 1234.)
  equal(f.calls.filter(c => c.cmd === "powershell").length, 1);
});

test("detectPortOccupant (win32): unknown PID in tasklist → not ours", () => {
  // Port 8765 listener PID 1234 is NOT in the tasklist snapshot.
  const f = fakeRunner({
    "cmd /c": [{ status: 0, stdout: NETSTAT_PORT_OCCUPIED, stderr: "" }],
    "tasklist /FO": [{ status: 0, stdout: "", stderr: "" }],
    "powershell -NoProfile": [{ status: 0, stdout: CIM_PIPELINE_CMDLINE, stderr: "" }],
  });
  const verdict = detectPortOccupant({ port: 8765, run: f.run, platform: "win32" });
  equal(verdict.inUse, true);
  equal(verdict.ours, false);
});

test("detectPortOccupant (win32): CIM probe failure → fall back to wmic → not ours", () => {
  // CIM throws (e.g. Windows PowerShell missing) and wmic returns other-node
  // command line (so the port-occupant probe cannot claim ownership).
  const f = fakeRunner({
    "cmd /c":     [{ status: 0, stdout: NETSTAT_PORT_OCCUPIED, stderr: "" }],
    "tasklist /FO":[{ status: 0, stdout: TASKLIST_PLAIN, stderr: "" }],
    "powershell -NoProfile":[{ __throw: true }],
    "wmic process":[{ status: 0, stdout: WMIC_OTHER_NODE_CMDLINE, stderr: "" }],
  });
  const verdict = detectPortOccupant({ port: 8765, run: f.run, platform: "win32" });
  equal(verdict.inUse, true);
  equal(verdict.ours, false);
  // Both probes were tried in order: PowerShell first, then wmic.
  equal(f.calls.filter(c => c.cmd === "powershell").length, 1);
  equal(f.calls.filter(c => c.cmd === "wmic").length, 1);
});

test("detectPortOccupant (win32): CIM AND wmic both fail → not ours, no throw", () => {
  const f = fakeRunner({
    "cmd /c":     [{ status: 0, stdout: NETSTAT_PORT_OCCUPIED, stderr: "" }],
    "tasklist /FO":[{ status: 0, stdout: TASKLIST_PLAIN, stderr: "" }],
    "powershell -NoProfile":[{ __throw: true }],
    "wmic process":[{ __throw: true }],
  });
  const verdict = detectPortOccupant({ port: 8765, run: f.run, platform: "win32" });
  equal(verdict.inUse, true);
  equal(verdict.ours, false);
});

test("detectPortOccupant: missing port → {inUse:false, ours:false}", () => {
  const verdict = detectPortOccupant({ port: 0, run: () => ({ status: 0, stdout: "" }) });
  equal(verdict.inUse, false);
  equal(verdict.ours, false);
});
