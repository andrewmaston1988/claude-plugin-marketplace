function descriptorShape(descriptor) {
  if (!descriptor || typeof descriptor !== "object") throw new Error("runner descriptor must be an object");
  if (typeof descriptor.id !== "string" || !/^[a-z][a-z0-9-]*$/.test(descriptor.id)) {
    throw new Error("runner descriptor id must be a canonical lowercase identifier");
  }
  return descriptor;
}

export function defaultRunnerDescriptors({ codexAdapter } = {}) {
  return [{ id: "claude" }, codexAdapter || { id: "codex" }];
}

export function createRunnerRegistry(initial = [], {
  providerRegistry = createProviderRegistry(defaultProviderAdapters()),
} = {}) {
  const descriptors = new Map();

  function register(descriptor) {
    const valid = descriptorShape(descriptor);
    if (descriptors.has(valid.id)) throw new Error(`runner '${valid.id}' is already registered`);
    descriptors.set(valid.id, valid);
    return valid;
  }

  for (const descriptor of initial) register(descriptor);

  function get(id) {
    const descriptor = descriptors.get(String(id || "").toLowerCase());
    if (!descriptor) throw new Error(`unknown runner '${id}'`);
    return descriptor;
  }

  function resolve(provider, { authoredRunner } = {}) {
    if (authoredRunner !== undefined) throw new Error("runner is derived from provider and cannot be authored");
    const providerId = provider?.provider || provider?.id;
    if (typeof providerId !== "string") {
      throw new Error("runner resolution requires provider identity");
    }
    const adapter = providerRegistry.get(providerId);
    if (provider.runnerId !== undefined && provider.runnerId !== adapter.runnerId) {
      throw new Error(`provider '${providerId}' cannot use runner '${provider.runnerId}'; expected '${adapter.runnerId}'`);
    }
    return get(adapter.runnerId);
  }

  return { register, get, list: () => [...descriptors.values()], resolve };
}
import { createProviderRegistry, defaultProviderAdapters } from "./providers.mjs";
