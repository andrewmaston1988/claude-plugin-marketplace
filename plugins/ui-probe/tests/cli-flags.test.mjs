// Flags the CLI does not understand are refused before any config, browser, TV or sdb work,
// and --help works anywhere in argv. Every invocation is a real child process, so the exit
// code and the loaded-module set are the ones a user gets.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { PLUGIN, noSdbEnv, probe, scratchConfig, scratchDir } from "./cli-support.mjs";
import { SUBCOMMAND_FLAGS, checkFlags } from "../src/flags.mjs";

// A refused or --help invocation must load none of these: that is what "touched nothing" means.
const DEVICE_MODULES = [
  "src/tv/cli.mjs",
  "src/tv/attach.mjs",
  "src/tv/sdb.mjs",
  "src/browser.mjs",
  "src/cdp.mjs",
  "src/config.mjs",
];

// Hook probes run from the plugin root and take --config explicitly, so a tv config lives in a
// scratch dir and no .ui-probe.json is ever discovered by accident.
function tvSetup(prefix) {
  const dir = scratchDir(prefix);
  const home = scratchDir(`${prefix}-home`);
  const configPath = path.join(dir, ".ui-probe.json");
  scratchConfig(dir, {
    baseUrl: "http://127.0.0.1:9",
    tv: { host: "192.0.2.10:26101", appid: "torrenthub.main" },
  });
  return { configPath, env: noSdbEnv(home) };
}

function logFile(prefix) {
  return path.join(scratchDir(prefix), "modules.log");
}

function assertNoDeviceModules(logPath, label) {
  const loaded = readFileSync(logPath, "utf8");
  assert.ok(loaded.includes("ui-probe.mjs"), `${label} recorded the CLI entry`);
  for (const name of DEVICE_MODULES) {
    assert.ok(!loaded.includes(name), `${label} must not load ${name}`);
  }
}

test("row 1: --help anywhere prints usage and loads no device module", async () => {
  const { configPath, env } = tvSetup("ui-probe-flags-help");
  const cases = [
    ["tv probe --help", ["tv", "probe", "--help", "--config", configPath]],
    ["tv probe -h", ["tv", "probe", "-h", "--config", configPath]],
    ["tv --help", ["tv", "--help", "--config", configPath]],
  ];
  for (const [label, args] of cases) {
    const log = logFile("ui-probe-flags-help-log");
    const result = await probe(args, { hook: true, log, env });
    assert.equal(result.status, 0, `${label} exited ${result.status}: ${result.stderr}`);
    assert.match(result.stdout, /^usage: ui-probe/m, `${label} prints usage`);
    assertNoDeviceModules(log, label);
  }
});

test("row 2: every subcommand refuses an unknown flag and honours --help after its name", async () => {
  const { configPath, env } = tvSetup("ui-probe-flags-subcommands");
  const cases = [
    ["capture", ["capture", "--config", configPath, "--nope"]],
    ["run", ["run", "scenario.yaml", "--config", configPath, "--nope"]],
    ["validate", ["validate", "--config", configPath, "--nope"]],
    ["screens", ["screens", "--config", configPath, "--nope"]],
    ["doctor", ["doctor", "--config", configPath, "--nope"]],
    ["tv probe", ["tv", "probe", "--config", configPath, "--nope"]],
  ];
  for (const [subcommand, args] of cases) {
    const log = logFile("ui-probe-flags-unknown-log");
    const result = await probe(args, { hook: true, log, env });
    assert.equal(result.status, 64, `${subcommand} --nope exited ${result.status}: ${result.stderr}`);
    assert.match(
      result.stderr,
      new RegExp(`unknown flag --nope for ${subcommand} — its flags are: `),
      `${subcommand} names the refused flag: ${result.stderr}`,
    );
    assert.match(result.stdout, /^usage: ui-probe/m, `${subcommand} prints usage with the refusal`);
    assertNoDeviceModules(log, `${subcommand} --nope`);
  }

  for (const [subcommand, args] of cases) {
    // The subcommand's own tokens lead, so this exercises its branch. Putting "--help" first
    // would take the global help path before the dispatch and prove nothing about the guard.
    const help = [...args.filter((arg) => arg !== "--nope"), "--help"];
    const log = logFile("ui-probe-flags-help-log");
    const result = await probe(help, { hook: true, log, env });
    assert.equal(result.status, 0, `${subcommand} --help exited ${result.status}: ${result.stderr}`);
    assert.match(result.stdout, /^usage: ui-probe/m, `${subcommand} --help prints usage`);
    assertNoDeviceModules(log, `${subcommand} --help`);
  }
});

test("row 3: a flag belongs to its own subcommand, and an unknown command keeps its path", async () => {
  const { configPath, env } = tvSetup("ui-probe-flags-scope");

  const runExit = await probe(["run", "x.yaml", "--config", configPath, "--exit"], { env });
  assert.equal(runExit.status, 64, `run --exit exited ${runExit.status}: ${runExit.stderr}`);
  assert.match(runExit.stderr, /unknown flag --exit for run/, runExit.stderr);

  const tvScreenshot = await probe(["tv", "probe", "--config", configPath, "--screenshot"], { env });
  assert.equal(tvScreenshot.status, 64, `tv probe --screenshot exited ${tvScreenshot.status}: ${tvScreenshot.stderr}`);
  assert.match(tvScreenshot.stderr, /unknown flag --screenshot for tv probe/, tvScreenshot.stderr);

  const bogus = await probe(["bogus", "--nope"]);
  assert.equal(bogus.status, 64, `an unknown command exited ${bogus.status}: ${bogus.stderr}`);
  assert.match(bogus.stderr, /unknown command: bogus/, bogus.stderr);
  assert.match(bogus.stdout, /^usage: ui-probe/m, "an unknown command still prints usage");
  assert.doesNotMatch(bogus.stderr, /TypeError|ERR_/, "an unknown command must not throw");

  const equals = await probe(["screens", `--config=${configPath}`], { env });
  assert.equal(equals.status, 64, `screens --config= exited ${equals.status}: ${equals.stderr}`);
  assert.ok(
    equals.stderr.includes(
      `--config=${configPath} is not supported — write --config ${configPath}`,
    ),
    `screens names the unsupported form: ${equals.stderr}`,
  );

  assert.equal(checkFlags("run", ["x.yaml", "--exit"]).unknown, "--exit", "run does not take tv probe's flag");
  assert.equal(checkFlags("tv probe", ["--screenshot"]).unknown, "--screenshot", "tv probe does not take capture's flag");
  assert.equal(checkFlags("screens", ["--config=x"]).equalsForm, true, "the = form of a real flag is reported as such");
  assert.throws(
    () => checkFlags("nosuch", []),
    /no flag table for subcommand "nosuch"/,
    "a subcommand with no table is a wiring error, not user input",
  );
});

test("row 4: a value flag consumes only an argument that is not itself a flag", () => {
  const accepted = [
    ["run", ["x.yaml", "--var", "k=-x", "--out", "-odd"]],
    ["tv probe", ["--listen", "-x"]],
    ["tv probe", ["--listen", "--listen-wait", "2"]],
    ["tv probe", ["--listen", "Left,Right"]],
    ["run", ["x.yaml", "--out"]],
  ];
  for (const [subcommand, args] of accepted) {
    assert.deepEqual(checkFlags(subcommand, args), { ok: true }, `${subcommand} ${args.join(" ")} is accepted`);
  }

  const runOut = checkFlags("run", ["x.yaml", "--out", "--nope"]);
  assert.equal(runOut.unknown, "--nope", "a flag after a value flag is checked in its own right");
  assert.deepEqual(runOut.known, Object.keys(SUBCOMMAND_FLAGS.run));

  const captureViewport = checkFlags("capture", ["s", "--viewport", "--nope"]);
  assert.equal(captureViewport.unknown, "--nope", "capture's value flags follow the same rule");
});

test("row 5a: every quoted flag literal in the source is listed by a subcommand table", () => {
  const known = new Set(["--help"]);
  for (const table of Object.values(SUBCOMMAND_FLAGS)) {
    for (const flag of Object.keys(table)) known.add(flag);
  }
  for (const file of ["bin/ui-probe.mjs", "src/tv/cli.mjs", "src/flags.mjs"]) {
    const source = readFileSync(path.join(PLUGIN, file), "utf8");
    const literals = [...source.matchAll(/["'](--[a-z][a-z0-9-]*)["']/g)].map((match) => match[1]);
    assert.ok(literals.length > 0, `${file} still contains quoted flag literals`);
    for (const literal of literals) {
      assert.ok(known.has(literal), `${file} reads ${literal}, which no subcommand table lists`);
    }
  }
});

test("row 5b: every flag a table lists is printed by --help", async () => {
  const help = await probe(["--help"]);
  assert.equal(help.status, 0, `--help exited ${help.status}: ${help.stderr}`);
  const printed = new Set(help.stdout.split(/\s+/));
  for (const [subcommand, table] of Object.entries(SUBCOMMAND_FLAGS)) {
    for (const flag of Object.keys(table)) {
      assert.ok(printed.has(flag), `${subcommand}'s ${flag} is missing from --help`);
    }
  }
});

test("row 5c: each table is exactly the flags its subcommand reads", () => {
  const expected = {
    capture: ["--config", "--url", "--viewport", "--var", "--out", "--device",
      "--allow-writes", "--include-background", "--attach-port", "--screenshot"],
    run: ["--config", "--viewport", "--var", "--out", "--device", "--allow-writes", "--attach-port"],
    validate: ["--config"],
    screens: ["--config"],
    doctor: ["--config"],
    "tv probe": ["--config", "--out", "--video", "--navigate", "--listen",
      "--listen-wait", "--fetch", "--exit", "--attach-port"],
  };
  assert.deepEqual(Object.keys(SUBCOMMAND_FLAGS).sort(), Object.keys(expected).sort(), "every subcommand has a table");
  for (const [subcommand, flags] of Object.entries(expected)) {
    assert.deepEqual(Object.keys(SUBCOMMAND_FLAGS[subcommand]).sort(), [...flags].sort(), subcommand);
  }
});
