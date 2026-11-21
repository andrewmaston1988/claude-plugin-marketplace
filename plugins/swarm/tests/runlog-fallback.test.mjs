// Roster identity after a model fallback: the reducer follows the `fallback` event.
import "./helpers/isolate-home.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { readRunLog } from "../src/runlog.mjs";

test("fallback-identity: the running row uses the recorded fallback identity", () => {
  const lines = [
    { event: "run-start", tasks: [{ id: "fix", model: "deepseek-v4.1-flash:1017-cloud", provider: "ollama", runner: "claude" }] },
    { id: "fix", event: "fallback", fromProvider: "ollama", toProvider: "codex", fromModel: "deepseek-v4.1-flash:1017-cloud", toModel: "gpt-6.2-sol" },
    { id: "fix", state: "running", provider: "codex", runner: "codex" },
  ].map((entry) => JSON.stringify(entry));
  const [row] = readRunLog(lines.join("\n")).tasks;
  assert.equal(row.model, "gpt-6.2-sol");
  assert.equal(row.provider, "codex");
  assert.equal(row.runner, "codex");
  assert.equal(Object.hasOwn(row, "providerInferred"), false);
  assert.equal(Object.hasOwn(row, "runnerInferred"), false);

  const [atFallback] = readRunLog(lines.slice(0, 2).join("\n")).tasks;
  assert.equal(atFallback.provider, "codex");
  assert.notEqual(atFallback.runner, "claude");
  assert.equal(Object.hasOwn(atFallback, "runnerInferred"), false);
});

test("fallback-identity-legacy: a fallback with only from/to updates the model", () => {
  const log = [
    { event: "run-start", tasks: [{ id: "fix", model: "deepseek-v4.1-flash:1017-cloud", provider: "ollama" }] },
    { id: "fix", event: "fallback", from: "deepseek-v4.1-flash:1017-cloud", to: "gpt-6.2-sol" },
  ].map((entry) => JSON.stringify(entry)).join("\n");
  const [row] = readRunLog(log).tasks;
  assert.equal(row.model, "gpt-6.2-sol");
  assert.notEqual(row.provider, "ollama");
});

test("fallback-rejected: the roster row retains the primary identity", () => {
  const primary = { id: "fix", model: "deepseek-v4.1-flash:1017-cloud", provider: "ollama", runner: "claude" };
  const log = [
    { event: "run-start", tasks: [primary] },
    { id: "fix", event: "fallback-rejected", fromProvider: "ollama", toProvider: "codex", toModel: "gpt-6.2-sol", reason: "provider disabled" },
  ].map((entry) => JSON.stringify(entry)).join("\n");
  const [row] = readRunLog(log).tasks;
  assert.equal(row.model, primary.model);
  assert.equal(row.provider, primary.provider);
  assert.equal(row.runner, primary.runner);
});
