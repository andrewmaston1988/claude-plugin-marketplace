import { ok, equal, deepEqual, throws } from "node:assert/strict";
import { modelDescriptor } from "../../src/contracts.mjs";
import { createProviderRegistry } from "../../src/providers.mjs";

const CAPABILITIES = new Set([
  "discoverModels",
  "readUsage",
  "preflight",
  "invalidateAvailability",
  "costObservations",
]);

export async function assertProviderAdapterContract(adapter, { config = {}, model = "fixture-model", context = {} } = {}) {
  ok(adapter && typeof adapter === "object", "provider adapter must be an object");
  ok(typeof adapter.id === "string" && adapter.id.length > 0, "provider adapter requires a stable id");
  ok(typeof adapter.runnerId === "string" && adapter.runnerId.length > 0, "provider adapter requires runnerId");
  equal(typeof adapter.enabled, "function", "provider adapter requires enabled(config)");
  equal(typeof adapter.validateTask, "function", "provider adapter requires validateTask(task, context)");
  ok(adapter.capabilities && typeof adapter.capabilities === "object" && !Array.isArray(adapter.capabilities), "provider capabilities must be an object");
  for (const [name, capability] of Object.entries(adapter.capabilities)) {
    ok(CAPABILITIES.has(name), `unknown provider capability '${name}'`);
    equal(typeof capability, "function", `provider capability '${name}' must be a function`);
  }
  const enabled = adapter.enabled(config);
  equal(typeof enabled, "boolean", "enabled(config) must return a boolean");
  const validation = await adapter.validateTask({ provider: adapter.id, model }, context);
  ok(Array.isArray(validation) && validation.every((problem) => typeof problem === "string"), "validateTask must return a scoped array of problem strings");

  const registry = createProviderRegistry([adapter]);
  deepEqual(registry.resolve({ provider: adapter.id, model }, { config, allowDisabled: true }), { provider: adapter.id, model }, "provider identity must round-trip through the registry");
  if (enabled) {
    deepEqual(registry.resolve({ provider: adapter.id, model }, { config }), { provider: adapter.id, model }, "enabled provider must resolve");
  } else {
    throws(() => registry.resolve({ provider: adapter.id, model }, { config }), /disabled/, "disabled provider must fail closed");
  }

  const discovery = registry.capability(adapter.id, "discoverModels");
  if (discovery === null) {
    equal(adapter.capabilities.discoverModels, undefined, "unsupported discovery must be absent, not a no-op");
  } else {
    const models = await discovery(context);
    ok(Array.isArray(models), "discoverModels must return an array");
    for (const descriptor of models) deepEqual(descriptor, modelDescriptor(descriptor), "discoverModels must return canonical model descriptors");
  }
  return true;
}
