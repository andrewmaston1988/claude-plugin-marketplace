import { test } from "node:test";
import { doesNotThrow, equal, throws } from "node:assert/strict";
import { createRunnerRegistry, defaultRunnerDescriptors } from "../src/runners.mjs";
import { createProviderRegistry, defaultProviderAdapters } from "../src/providers.mjs";
import { assertRunnerAdapterContract } from "./helpers/runner-contract.mjs";

function fixtureRunner(overrides = {}) {
  const cancelled = new WeakSet();
  return {
    id: "fixture",
    buildInvocation: (task, prompt) => ({ argv: ["fixture", task.model, prompt, ...(task.sessionId ? ["--resume", task.sessionId] : [])], env: {} }),
    createParser: (emit) => ({ push: () => emit({ type: "activity", activity: { phase: "running" } }), end: () => emit({ type: "completed", terminal: true }) }),
    classifyExit: (_exit, parsed) => parsed,
    cancel: (child) => {
      if (cancelled.has(child)) return;
      cancelled.add(child);
      child.kill();
    },
    ...overrides,
  };
}

test("provider runner mapping is derived from the adapter and authored runner is rejected", () => {
  const registry = createRunnerRegistry(defaultRunnerDescriptors());
  equal(registry.resolve({ id: "claude", runnerId: "claude" }).id, "claude");
  equal(registry.resolve({ id: "ollama", runnerId: "claude" }).id, "claude");
  equal(registry.resolve({ id: "codex", runnerId: "codex" }).id, "codex");
  throws(() => registry.resolve({ id: "ollama", runnerId: "codex" }), /ollama.*codex.*claude/);
  throws(() => registry.resolve({ id: "codex", runnerId: "claude" }), /codex.*claude.*codex/);
  throws(() => registry.resolve({ id: "claude", runnerId: "claude" }, { authoredRunner: "codex" }), /runner.*authored/i);
});

test("runner identifiers reject mixed case and surrounding whitespace", () => {
  throws(() => createRunnerRegistry([{ id: "Fixture" }]), /canonical lowercase identifier/);
  throws(() => createRunnerRegistry([{ id: " fixture" }]), /canonical lowercase identifier/);
});

test("a fourth provider resolves a registered fourth runner without a central mapping edit", () => {
  const providers = createProviderRegistry(defaultProviderAdapters());
  providers.register({
    id: "fixture",
    runnerId: "fixture-runner",
    enabled: () => true,
    matchModel: (model) => ({ provider: "fixture", model }),
    validateTask: () => [],
    capabilities: {},
  });
  const registry = createRunnerRegistry(defaultRunnerDescriptors(), { providerRegistry: providers });
  registry.register({ id: "fixture-runner" });
  equal(registry.resolve({ id: "fixture", runnerId: "fixture-runner" }).id, "fixture-runner");
  throws(() => registry.resolve({ id: "fixture", runnerId: "missing" }), /fixture.*missing.*fixture-runner/);
});

test("runner contract helper rejects broken adapters and accepts a conforming fake", () => {
  throws(() => assertRunnerAdapterContract({ id: "broken" }), /buildInvocation/);
  doesNotThrow(() => assertRunnerAdapterContract(fixtureRunner()));
});

test("runner contract helper rejects protocol leakage, double settlement, lost resume, and missed cancellation", () => {
  throws(() => assertRunnerAdapterContract(fixtureRunner({
    createParser: (emit) => ({ push: () => emit({ type: "activity", raw: {} }), end: () => emit({ type: "completed", terminal: true }) }),
  })), /raw protocol/);
  throws(() => assertRunnerAdapterContract(fixtureRunner({
    createParser: (emit) => ({ push: () => emit({ type: "completed", terminal: true }), end: () => emit({ type: "completed", terminal: true }) }),
  })), /settle exactly once/);
  throws(() => assertRunnerAdapterContract(fixtureRunner({
    buildInvocation: (task, prompt) => ({ argv: ["fixture", task.model, prompt], env: {} }),
  })), /resume identity/);
  throws(() => assertRunnerAdapterContract(fixtureRunner({ cancel: () => {} })), /clean up the child once/);
});
