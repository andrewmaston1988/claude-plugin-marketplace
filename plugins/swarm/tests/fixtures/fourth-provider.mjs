import { modelDescriptor, providerUsageSnapshot } from "../../src/contracts.mjs";
import { defaultProviderRegistry } from "../../src/default-providers.mjs";

// Test-only provider. Production code must discover, persist, render, and
// dispatch this through public registry contracts rather than a provider-name
// conditional.
export const FIXTURE_MODEL = "fixture-model";

export function fixtureProvider(model = FIXTURE_MODEL) {
  return {
    id: "fixture",
    runnerId: "fixture",
    enabled: (config = {}) => config.providers?.fixture?.enabled === true,
    matchModel: (candidate) => candidate === model ? { provider: "fixture", model: candidate } : null,
    validateTask: () => [],
    capabilities: {
      discoverModels: async () => [modelDescriptor({ provider: "fixture", model, runner: "fixture", displayName: "Fixture model" })],
      readUsage: async () => providerUsageSnapshot({
        provider: "fixture",
        buckets: [{ kind: "weekly", percent: 12 }],
        source: "fixture",
        provenance: "live",
        asOf: new Date().toISOString(),
      }),
    },
  };
}

export function fixtureRunner() {
  return {
    id: "fixture",
    parser: "claude",
    buildInvocation: (task, prompt) => ({ argv: ["fixture-runner", "--model", task.model, prompt], env: {}, parser: "claude" }),
  };
}

export function fixtureRegistry({ model = FIXTURE_MODEL } = {}) {
  return defaultProviderRegistry({ additionalProviders: [fixtureProvider(model)] });
}
