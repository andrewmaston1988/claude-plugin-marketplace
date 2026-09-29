// The scheduler end of the native `returns` bind: the strict-form schema file it
// writes beside the results, and the null-stripping that keeps the author's own
// schema the thing validated. Split from scheduler.test.mjs, which is past the
// file-size bar and may not grow.
import { test } from "node:test";
import { equal, deepEqual, ok } from "node:assert/strict";
import { rmSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { runPlan } from "../src/scheduler.mjs";
import { strictSchema } from "../src/native-schema.mjs";
import { readResult } from "../src/results.mjs";
import { fakeSpawnFactory, makeIo } from "./helpers/fake-io.mjs";
import { CFG, tmp, task, plan } from "./helpers/scheduler-fixtures.mjs";

const RETURNS = {
  type: "object",
  required: ["findings"],
  properties: { findings: { type: "array", items: { type: "string" } }, note: { type: "string" } },
};

// A leaf otherwise learns its `returns` only at the re-ask. The runner binds it itself:
// claude takes the schema inline on argv, codex needs a file in OpenAI strict form —
// and the scheduler, which already owns resultsDir, is what writes it. The builders
// stay pure.
test("returns: the scheduler writes the strict schema beside the results and binds the leaf to it", async () => {
  const dir = tmp();
  try {
    const spawn = fakeSpawnFactory(() => ({ output: '{"findings":[]}' }));
    const io = makeIo(spawn);
    const p = plan(dir, [task("a", { cwd: dir, returns: RETURNS })]);
    await runPlan(p, CFG, io);

    const schemaFile = join(p.resultsDir, "a.schema.json");
    ok(existsSync(schemaFile), "the strict-copy schema file is written beside the results");
    deepEqual(JSON.parse(readFileSync(schemaFile, "utf8")), strictSchema(RETURNS));
    // Claude validates the engine's own grammar, so argv carries the authored schema.
    const args = spawn.calls[0].args;
    const i = args.indexOf("--json-schema");
    ok(i > 0, args.join(" "));
    equal(args[i + 1], JSON.stringify(RETURNS));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// Strict form forces every property present, so an optional one the model declined
// arrives as an explicit null. Dropping it before validateValue is what keeps the
// author's schema the thing checked — without it the leaf re-asks for nothing.
test("returns: a null optional passes the contract with no re-ask", async () => {
  const dir = tmp();
  try {
    const stream = [
      JSON.stringify({ type: "system", subtype: "init", session_id: "s-1" }),
      JSON.stringify({
        type: "result", subtype: "success", is_error: false,
        result: '{"findings":["one"],"note":null}',
        structured_output: { findings: ["one"], note: null },
      }),
    ].join("\n") + "\n";
    const spawn = fakeSpawnFactory(() => ({ output: stream }));
    const io = makeIo(spawn);
    const p = plan(dir, [task("a", { cwd: dir, returns: RETURNS })]);
    const r = await runPlan(p, CFG, io);

    equal(spawn.calls.length, 1, "a null optional must not trigger the contract re-ask");
    equal(r.summary.tasks[0].state, "ok");
    equal(readResult(p.resultsDir, "a").schemaRetried, undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// A schema with no strict form gets no codex file, so codex runs unbound and the
// engine's re-ask is the backstop; claude still takes the authored schema.
test("returns: a schema with no strict form writes no schema file", async () => {
  const dir = tmp();
  try {
    const spawn = fakeSpawnFactory(() => ({ output: '{"a":1}' }));
    const p = plan(dir, [task("a", { cwd: dir, returns: { type: "object", required: ["a"] } })]);
    await runPlan(p, CFG, makeIo(spawn));
    ok(!existsSync(join(p.resultsDir, "a.schema.json")), "no strict copy for an unexpressible schema");
    ok(spawn.calls[0].args.includes("--json-schema"), spawn.calls[0].args.join(" "));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// dropNullOptionals only helps validation if the stored output is the stripped value
// too — compute/when/forEach.from read the stored text, and the docs promise no nulls.
test("returns: a null optional is dropped from the stored output, citations or not", async () => {
  const dir = tmp();
  try {
    const spawn = fakeSpawnFactory(() => ({ output: '{"findings":["one"],"note":null}' }));
    const p = plan(dir, [task("a", { cwd: dir, returns: RETURNS })]);
    await runPlan(p, CFG, makeIo(spawn));
    deepEqual(JSON.parse(readResult(p.resultsDir, "a").output), { findings: ["one"] });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// Codex strict mode needs an object root; a non-object root gets no file and runs unbound.
test("returns: a non-object root writes no schema file", async () => {
  const dir = tmp();
  try {
    const spawn = fakeSpawnFactory(() => ({ output: '["x"]' }));
    const p = plan(dir, [task("a", { cwd: dir, returns: { type: "array", items: { type: "string" } } })]);
    await runPlan(p, CFG, makeIo(spawn));
    ok(!existsSync(join(p.resultsDir, "a.schema.json")), "no strict copy for a non-object root");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
