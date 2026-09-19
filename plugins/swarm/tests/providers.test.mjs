import { test } from "node:test";
import { deepEqual, equal, rejects, throws } from "node:assert/strict";
import { createProviderRegistry, defaultProviderAdapters } from "../src/providers.mjs";
import { assertProviderAdapterContract } from "./helpers/provider-contract.mjs";

const config = {
  providers: {
    claude: { enabled: true },
    ollama: { enabled: true },
    codex: { enabled: false },
  },
};

test("provider resolution order is explicit, cache, Claude identity, legacy Ollama", () => {
  const registry = createProviderRegistry(defaultProviderAdapters());
  equal(registry.resolve({ provider: "codex", model: "gpt-5" }, { config, allowDisabled: true }).provider, "codex");
  equal(registry.resolve({ model: "gpt-5" }, { config, cache: [{ provider: "codex", model: "gpt-5" }], allowDisabled: true }).provider, "codex");
  equal(registry.resolve({ model: "sonnet" }, { config }).provider, "claude");
  equal(registry.resolve({ model: "gpt-oss:20b-cloud" }, { config }).provider, "ollama");
  equal(registry.resolve({ model: "gpt-oss:120b-cloud" }, { config }).provider, "ollama");
  equal(registry.resolve({ model: "gpt-new-uncached" }, { config }).provider, "ollama");
});

test("ambiguous provider-qualified cache rows require explicit provider", () => {
  const registry = createProviderRegistry(defaultProviderAdapters());
  const cache = [
    { provider: "ollama", model: "same-id" },
    { provider: "codex", model: "same-id" },
  ];
  throws(() => registry.resolve({ model: "same-id" }, { config, cache }), /same-id.*provider/);
  deepEqual(registry.resolve({ provider: "codex", model: "same-id" }, { config, cache, allowDisabled: true }), {
    provider: "codex", model: "same-id",
  });
});

test("disabled providers fail unless the caller is inspecting identity only", () => {
  const registry = createProviderRegistry(defaultProviderAdapters());
  throws(() => registry.resolve({ provider: "codex", model: "gpt-5" }, { config }), /codex.*disabled/);
  equal(registry.resolve({ provider: "codex", model: "gpt-5" }, { config, allowDisabled: true }).provider, "codex");
});

test("provider resolution rejects whitespace-only models and canonicalizes surrounding whitespace", () => {
  const registry = createProviderRegistry(defaultProviderAdapters());
  throws(() => registry.resolve({ model: "   " }, { config }), /non-empty model/);
  deepEqual(registry.resolve({ model: "  sonnet  " }, { config }), { provider: "claude", model: "sonnet" });
});

test("a registered fourth provider participates in inference without a production branch", () => {
  const registry = createProviderRegistry(defaultProviderAdapters());
  registry.register({
    id: "fixture",
    runnerId: "fixture-runner",
    enabled: () => true,
    matchModel: (model) => model.startsWith("fixture-") ? { provider: "fixture", model } : null,
    validateTask: () => [],
    capabilities: {},
  });
  deepEqual(registry.resolve({ model: "fixture-model" }, { config }), {
    provider: "fixture", model: "fixture-model",
  });
});

test("multiple adapter matches are ambiguous and mismatched adapter identities are rejected", () => {
  const matching = (id, returned = id) => ({
    id,
    runnerId: "claude",
    enabled: () => true,
    matchModel: (model) => ({ provider: returned, model }),
    validateTask: () => [],
    capabilities: {},
  });
  const ambiguous = createProviderRegistry([matching("one"), matching("two")]);
  throws(() => ambiguous.resolve({ model: "x" }), /multiple providers.*one, two/);
  const mismatched = createProviderRegistry([matching("one", "other")]);
  throws(() => mismatched.resolve({ model: "x" }), /mismatched identity/);
});

test("provider contract helper rejects broken adapters and accepts defaults", async () => {
  await rejects(() => assertProviderAdapterContract({ id: "broken" }), /runnerId/);
  for (const adapter of defaultProviderAdapters()) {
    await assertProviderAdapterContract(adapter, { config });
  }
});

test("provider contract helper enforces scoped validation and canonical discovery", async () => {
  const fixture = {
    id: "fixture",
    runnerId: "claude",
    enabled: () => true,
    matchModel: (model) => ({ provider: "fixture", model }),
    validateTask: () => ["fixture-scoped problem"],
    capabilities: {
      discoverModels: async () => [{ provider: "fixture", model: "fixture-model", runner: "claude" }],
    },
  };
  await assertProviderAdapterContract(fixture, { config });
  await rejects(() => assertProviderAdapterContract({ ...fixture, validateTask: () => "global failure" }, { config }), /scoped array/);
  await rejects(() => assertProviderAdapterContract({
    ...fixture,
    capabilities: { discoverModels: async () => [{ provider: "fixture", model: "fixture-model", runner: "claude", isDefault: "yes" }] },
  }, { config }), /isDefault.*boolean/);
});

test("optional capabilities are explicit and unknown capabilities stay scoped", () => {
  const registry = createProviderRegistry(defaultProviderAdapters());
  equal(registry.capability("codex", "readUsage"), null);
  throws(() => registry.capability("codex", "invented"), /unknown provider capability/);
  throws(() => registry.register({
    id: "broken-capability",
    runnerId: "claude",
    enabled: () => true,
    matchModel: () => null,
    validateTask: () => [],
    capabilities: { invented: () => {} },
  }), /unknown capability 'invented'/);
});

test("provider and runner identifiers reject mixed case and surrounding whitespace", () => {
  const base = {
    runnerId: "claude",
    enabled: () => true,
    matchModel: () => null,
    validateTask: () => [],
    capabilities: {},
  };
  throws(() => createProviderRegistry([{ ...base, id: "Fixture" }]), /canonical lowercase identifier/);
  throws(() => createProviderRegistry([{ ...base, id: " fixture" }]), /canonical lowercase identifier/);
  throws(() => createProviderRegistry([{ ...base, id: "fixture", runnerId: "Claude" }]), /canonical lowercase identifier/);
});
