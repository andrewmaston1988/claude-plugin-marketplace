import { isClaudeModel } from "./contracts.mjs";

const PROVIDER_CAPABILITIES = new Set([
  "discoverModels",
  "readUsage",
  "preflight",
  "invalidateAvailability",
  "costObservations",
]);

function adapterShape(adapter) {
  if (!adapter || typeof adapter !== "object") throw new Error("provider adapter must be an object");
  for (const field of ["id", "runnerId"]) {
    if (typeof adapter[field] !== "string" || !/^[a-z][a-z0-9-]*$/.test(adapter[field])) {
      throw new Error(`provider adapter ${field} must be a canonical lowercase identifier`);
    }
  }
  for (const method of ["enabled", "matchModel", "validateTask"]) {
    if (typeof adapter[method] !== "function") throw new Error(`provider '${adapter.id}' requires ${method}()`);
  }
  if (!adapter.capabilities || typeof adapter.capabilities !== "object" || Array.isArray(adapter.capabilities)) {
    throw new Error(`provider '${adapter.id}' capabilities must be an object`);
  }
  for (const [name, capability] of Object.entries(adapter.capabilities)) {
    if (!PROVIDER_CAPABILITIES.has(name)) throw new Error(`provider '${adapter.id}' has unknown capability '${name}'`);
    if (typeof capability !== "function") throw new Error(`provider '${adapter.id}' capability '${name}' must be a function`);
  }
  return adapter;
}

function configured(config, id, fallback) {
  const block = config?.providers?.[id];
  return typeof block?.enabled === "boolean" ? block.enabled : fallback;
}

function descriptor({ id, runnerId, defaultEnabled, matchModel }) {
  return {
    id,
    runnerId,
    enabled: (config) => configured(config, id, defaultEnabled),
    matchModel,
    validateTask: () => [],
    capabilities: {},
  };
}

export function defaultProviderAdapters() {
  return [
    descriptor({
      id: "claude",
      runnerId: "claude",
      defaultEnabled: true,
      matchModel: (model) => isClaudeModel(model) ? { provider: "claude", model } : null,
    }),
    descriptor({
      id: "ollama",
      runnerId: "claude",
      defaultEnabled: true,
      matchModel: (model) => /(:|-)cloud$/i.test(String(model || "")) ? { provider: "ollama", model } : null,
    }),
    descriptor({
      id: "codex",
      runnerId: "codex",
      defaultEnabled: false,
      matchModel: (model, cache = []) => cache.some((row) => row?.provider === "codex" && row?.model === model)
        ? { provider: "codex", model }
        : null,
    }),
  ];
}

export function createProviderRegistry(initial = []) {
  const adapters = new Map();

  function register(adapter) {
    const valid = adapterShape(adapter);
    if (adapters.has(valid.id)) throw new Error(`provider '${valid.id}' is already registered`);
    adapters.set(valid.id, valid);
    return valid;
  }

  for (const adapter of initial) register(adapter);

  function get(id) {
    const adapter = adapters.get(String(id || "").toLowerCase());
    if (!adapter) throw new Error(`unknown provider '${id}'`);
    return adapter;
  }

  function identity(adapter, model, config, allowDisabled) {
    if (!allowDisabled && !adapter.enabled(config)) throw new Error(`provider '${adapter.id}' is disabled`);
    return { provider: adapter.id, model };
  }

  function resolve(task, { cache = [], config = {}, allowDisabled = false } = {}) {
    const authoredModel = task?.model;
    if (typeof authoredModel !== "string" || !authoredModel.trim()) throw new Error("provider resolution requires a non-empty model");
    const model = authoredModel.trim();
    if (task.provider !== undefined) return identity(get(task.provider), model, config, allowDisabled);

    const cacheProviders = [...new Set(cache
      .filter((row) => row?.model === model && typeof row?.provider === "string")
      .map((row) => row.provider.toLowerCase()))];
    if (cacheProviders.length > 1) {
      throw new Error(`model '${model}' exists under multiple providers (${cacheProviders.join(", ")}) — set provider explicitly`);
    }
    if (cacheProviders.length === 1) return identity(get(cacheProviders[0]), model, config, allowDisabled);

    const matches = [];
    for (const adapter of adapters.values()) {
      const match = adapter.matchModel(model, cache);
      if (match) matches.push({ adapter, match });
    }
    if (matches.length > 1) {
      throw new Error(`model '${model}' matches multiple providers (${matches.map(({ adapter }) => adapter.id).join(", ")}) — set provider explicitly`);
    }
    if (matches.length === 1) {
      const { adapter, match } = matches[0];
      if (match.provider !== adapter.id || match.model !== model) {
        throw new Error(`provider '${adapter.id}' matchModel() returned a mismatched identity`);
      }
      return identity(adapter, model, config, allowDisabled);
    }
    return identity(get("ollama"), model, config, allowDisabled);
  }

  return {
    register,
    get,
    list: () => [...adapters.values()],
    resolve,
    capability(provider, name) {
      if (!PROVIDER_CAPABILITIES.has(name)) throw new Error(`unknown provider capability '${name}'`);
      return get(provider).capabilities[name] || null;
    },
  };
}
