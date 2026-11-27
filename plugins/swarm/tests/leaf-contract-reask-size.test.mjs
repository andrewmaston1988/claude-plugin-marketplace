import "./helpers/isolate-home.mjs";
import { test } from "node:test";
import { deepEqual, doesNotMatch, equal, match, ok } from "node:assert/strict";
import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { windowsCommandLineLength } from "../src/dispatch.mjs";
import * as dispatchBudget from "../src/manifest-dispatch-budget.mjs";
import { initResultsDir } from "../src/results.mjs";
import { enforceLeafContract } from "../src/scheduler/leaf-contract.mjs";
import { runTask } from "../src/scheduler/run-task.mjs";
import { fakeSpawnFactory, makeIo, sentPrompt } from "./helpers/fake-io.mjs";
import { CFG, streamOut, task, tmp } from "./helpers/scheduler-fixtures.mjs";

const FINDINGS = { type: "array", items: { type: "string" } };
const fieldError = /output\[0\]: missing required field 'findings'/;
const schemaHeading = "The required schema is:\n";
const argvLength = ({ cmd, args }) => windowsCommandLineLength([cmd, ...args]);

function largeArraySchema() {
  const returns = {
    type: "array",
    items: {
      type: "object",
      required: ["findings"],
      properties: {
        findings: FINDINGS,
        ...Object.fromEntries(Array.from({ length: 400 }, (_, i) => [`field${i}`, { type: "string" }])),
        marker: { type: "string", enum: [""] },
      },
    },
  };
  returns.items.properties.marker.enum[0] = "x".repeat(31428 - JSON.stringify(returns, null, 2).length);
  return returns;
}

function codexOutput(output) {
  return [
    { type: "thread.started", thread_id: "session-1" },
    { type: "item.completed", item: { id: "msg", type: "agent_message", text: output } },
    { type: "turn.completed", usage: { input_tokens: 1, output_tokens: 1 } },
  ].map((event) => JSON.stringify(event)).join("\n") + "\n";
}

async function reask(t, { returns, runner, output = "[{}]", corrected = '[{"findings":[]}]', spawnLimit, extra = {} }) {
  const dir = tmp();
  t.after(() => rmSync(dir, { force: true, recursive: true }));
  const resultsDir = join(dir, "run");
  initResultsDir(resultsDir);
  const codex = runner === "codex";
  const id = "leaf";
  const leaf = task(id, { cwd: dir, returns, ...extra, ...(codex && { provider: "codex", model: "gpt-5-codex" }) });
  const cfg = codex
    ? { ...CFG, providers: { codex: { enabled: true, path: process.execPath, allowedRoots: [dir] } } }
    : { ...CFG, claudePath: process.execPath };
  const initial = { ok: true, durationMs: 0, sessionId: "session-1", output, runner };
  const spawn = fakeSpawnFactory((call) => {
    if (argvLength(call) > spawnLimit) {
      const error = new Error("spawn ENAMETOOLONG");
      error.code = "ENAMETOOLONG";
      throw error;
    }
    return { output: codex ? codexOutput(corrected) : streamOut(corrected, initial.sessionId) };
  });
  const io = makeIo(spawn, { platform: "win32", env: { ...process.env, SWARM_HOME: dir } });
  const result = await enforceLeafContract(leaf, initial, dir, resultsDir, cfg, io, {}, { resultsDir }, runTask);
  equal(spawn.calls.length, 1);
  return { result, call: spawn.calls[0], schemaPath: join(resultsDir, `${id}.schema.json`) };
}

test("Claude re-asks with field errors and leaves a 31,428-character schema on the native flag", async (t) => {
  const returns = largeArraySchema();
  equal(JSON.stringify(returns, null, 2).length, 31428);
  const { result, call } = await reask(t, { returns, runner: "claude" });
  equal(result.ok, true, result.output);
  const flag = call.args.indexOf("--json-schema");
  ok(flag >= 0);
  equal(call.args[flag + 1] === JSON.stringify(returns), true);
  const prompt = sentPrompt(call);
  match(prompt, fieldError);
  ok(!prompt.includes(schemaHeading), "the prompt repeats the native schema");
  ok(!prompt.includes('"properties"'), "the prompt includes a schema body");
});

test("An unbound Codex re-ask includes the same large schema as compact JSON", async (t) => {
  const returns = largeArraySchema();
  const { result, call } = await reask(t, { returns, runner: "codex" });
  equal(result.ok, true, result.output);
  ok(!call.args.includes("--output-schema"));
  const prompt = sentPrompt(call);
  match(prompt, fieldError);
  ok(prompt.includes(schemaHeading + JSON.stringify(returns)), "the prompt needs compact JSON");
});

test("An oversized re-ask spawns below the Windows limit with errors and a readable schema path", async (t) => {
  const returns = { type: "string", enum: ['a"'.repeat(9000)] };
  const { result, call, schemaPath } = await reask(t, {
    returns, runner: "codex", output: "false", corrected: JSON.stringify(returns.enum[0]), spawnLimit: 32767,
  });
  ok(result.ok, result.output.slice(0, 200));
  doesNotMatch(result.output, /ENAMETOOLONG/);
  const prompt = sentPrompt(call);
  match(prompt, /output: expected string, got boolean/);
  ok(prompt.includes(schemaPath), "the correction needs the schema path");
  deepEqual(JSON.parse(readFileSync(schemaPath, "utf8")), returns);
  ok(argvLength(call) <= dispatchBudget.WIN_CMDLINE_MAX);
});

test("Re-asks use the exported dispatch budget at the command-line boundary", async (t) => {
  const budget = dispatchBudget.WIN_CMDLINE_MAX;
  ok(Number.isInteger(budget), "the dispatch budget needs to be exported");
  const returns = { type: "string", enum: ["ok"] };
  const base = await reask(t, { returns, runner: "codex", output: "false", corrected: '"ok"' });
  const atLimit = "x".repeat(budget - argvLength(base.call)) + "ok";
  for (const extra of ["", "x"]) {
    const answer = atLimit + extra;
    const { result, call, schemaPath } = await reask(t, {
      returns: { ...returns, enum: [answer] }, runner: "codex", output: "false", corrected: JSON.stringify(answer),
    });
    equal(result.ok, true);
    const prompt = sentPrompt(call);
    if (extra) ok(prompt.includes(schemaPath), "one character above budget must use the schema file");
    else {
      equal(argvLength(call), budget);
      ok(prompt.includes(schemaHeading), "an exact fit keeps the inline schema");
    }
  }
});

test("A small unbound re-ask still provides the field errors and the schema", async (t) => {
  const returns = { type: "array", items: { type: "object", required: ["findings"], properties: { findings: FINDINGS } } };
  const { result, call } = await reask(t, { returns, runner: "codex" });
  equal(result.ok, true, result.output);
  const prompt = sentPrompt(call);
  match(prompt, fieldError);
  const schemaBlock = prompt.split(schemaHeading)[1].split("\nReply with")[0];
  deepEqual(JSON.parse(schemaBlock), returns);
});

test("Codex omits inline JSON when the strict file is passed via the native flag", async (t) => {
  const returns = { type: "object", required: ["findings"], properties: { findings: FINDINGS } };
  const { result, call, schemaPath } = await reask(t, {
    returns, runner: "codex", output: "{}", corrected: '{"findings":[]}',
  });
  equal(result.ok, true, result.output);
  const flag = call.args.indexOf("--output-schema");
  ok(flag >= 0);
  equal(call.args[flag + 1], schemaPath);
  match(sentPrompt(call), /output: missing required field 'findings'/);
  ok(!sentPrompt(call).includes(schemaHeading), "the prompt repeats the bound schema");
});

test("An oversized re-ask keeps the coverage block beside the schema path", async (t) => {
  const returns = { type: "string", enum: ['a"'.repeat(9000)] };
  const mustRead = [join(tmp(), "needed-file.md")];
  const { call, schemaPath } = await reask(t, {
    returns, runner: "codex", output: "false", corrected: JSON.stringify(returns.enum[0]),
    spawnLimit: 32767, extra: { mustRead },
  });
  const prompt = sentPrompt(call);
  ok(prompt.includes(schemaPath), "the correction needs the schema path");
  ok(prompt.includes("needed-file.md"), "the coverage block must survive the overflow");
  ok(argvLength(call) <= dispatchBudget.WIN_CMDLINE_MAX);
});

test("An oversized field error keeps a teaching prefix and the bound schema path", async (t) => {
  const field = "findings-" + "x".repeat(33000);
  const returns = { type: "object", required: [field], properties: { [field]: FINDINGS } };
  const corrected = JSON.stringify({ [field]: [] });
  const { result, call, schemaPath } = await reask(t, {
    returns, runner: "codex", output: "{}", corrected, spawnLimit: 32767,
  });
  ok(result.ok, result.output.slice(0, 200));
  const prompt = sentPrompt(call);
  match(prompt, /output: missing required field 'findings-/);
  ok(prompt.includes(schemaPath), "the path must survive error truncation");
  ok(argvLength(call) <= dispatchBudget.WIN_CMDLINE_MAX);
});
