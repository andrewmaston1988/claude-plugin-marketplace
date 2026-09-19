import { ok, equal, deepEqual } from "node:assert/strict";
import { runResult, runnerEvent } from "../../src/contracts.mjs";

export function assertRunnerAdapterContract(adapter, {
  task = { provider: "fixture", model: "fixture-model" },
  prompt = "fixture prompt",
  context = {},
} = {}) {
  ok(adapter && typeof adapter === "object", "runner adapter must be an object");
  ok(typeof adapter.id === "string" && adapter.id.length > 0, "runner adapter requires a stable id");
  for (const method of ["buildInvocation", "createParser", "classifyExit", "cancel"]) {
    equal(typeof adapter[method], "function", `runner adapter requires ${method}()`);
  }
  const invocation = adapter.buildInvocation(task, prompt, context);
  ok(Array.isArray(invocation?.argv) && invocation.argv.length > 0, "buildInvocation must return non-empty argv");
  ok(invocation.env && typeof invocation.env === "object", "buildInvocation must return env");
  const events = [];
  const parser = adapter.createParser((event) => events.push(event), context);
  ok(parser && typeof parser.push === "function" && typeof parser.end === "function", "createParser must return push/end parser");
  parser.push("fixture chunk");
  parser.end();
  ok(events.length > 0, "parser must emit canonical events");
  for (const event of events) deepEqual(event, runnerEvent(event), "runner event must not leak raw protocol fields");
  equal(events.filter((event) => event.terminal === true).length, 1, "parser must settle exactly once");

  const parsed = { provider: task.provider, model: task.model, output: "fixture output", terminal: true };
  deepEqual(adapter.classifyExit({ code: 0 }, parsed), runResult(parsed), "classifyExit must return a canonical result");

  const resumed = adapter.buildInvocation({ ...task, sessionId: "fixture-session" }, prompt, context);
  ok(resumed.argv.includes("fixture-session"), "buildInvocation must preserve resume identity");

  let cancelled = 0;
  const child = { kill: () => { cancelled += 1; } };
  adapter.cancel(child);
  adapter.cancel(child);
  equal(cancelled, 1, "timeout/cancel races must clean up the child once");
  return true;
}
