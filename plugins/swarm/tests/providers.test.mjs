import { test } from "node:test";
import { deepEqual, equal, ok, rejects, throws } from "node:assert/strict";
import { createProviderRegistry, defaultProviderAdapters } from "../src/providers.mjs";
import { assertProviderAdapterContract } from "./helpers/provider-contract.mjs";

const config = {
  providers: {
    claude: { enabled: true },
    ollama: { enabled: true },
    codex: { enabled: false },
  },
};

test("resolve() reads the authored provider and infers nothing", () => {
  const registry = createProviderRegistry(defaultProviderAdapters());
  equal(registry.resolve({ provider: "codex", model: "gpt-5" }, { config, allowDisabled: true }).provider, "codex");
  equal(registry.resolve({ provider: "claude", model: "claude-sonnet-5" }, { config }).provider, "claude");
  equal(registry.resolve({ provider: "ollama", model: "gpt-oss:20b-cloud" }, { config }).provider, "ollama");
  // Formerly swallowed by the Ollama fallback; now the author must say so.
  equal(registry.resolve({ provider: "ollama", model: "gpt-new-uncached" }, { config }).provider, "ollama");
});

test("a model with no provider throws, even one the discovery cache knows", () => {
  const registry = createProviderRegistry(defaultProviderAdapters());
  throws(() => registry.resolve({ model: "gpt-new-uncached" }, { config }), /no "provider".*registered: claude, ollama, codex/);
  throws(() => registry.resolve({ model: "gpt-5" }, { config, cache: [{ provider: "codex", model: "gpt-5" }], allowDisabled: true }), /no "provider"/);
  throws(() => registry.resolve({ model: "gpt-oss:20b-cloud" }, { config }), /no "provider"/);
  throws(() => registry.resolve({ model: "claude-opus-5", provider: "  " }, { config }), /no "provider"/);
});

test("an unknown provider id is refused, naming the registered ids", () => {
  const registry = createProviderRegistry(defaultProviderAdapters());
  throws(() => registry.resolve({ provider: "nope", model: "x" }, { config }), /unknown provider 'nope' \(registered: claude, ollama, codex\)/);
});

test("Claude aliases are refused as model names, under any provider", () => {
  const registry = createProviderRegistry(defaultProviderAdapters());
  for (const alias of ["haiku", "sonnet", "opus", "fable", "Sonnet"]) {
    throws(() => registry.resolve({ provider: "claude", model: alias }, { config }), /Claude alias.*claude-opus-5/, alias);
    throws(() => registry.resolve({ provider: "ollama", model: alias }, { config }), /Claude alias/, alias);
  }
});

test("a model that is valid but not for the named provider is refused by that provider's validateTask", () => {
  const registry = createProviderRegistry(defaultProviderAdapters());
  ok(registry.get("ollama").validateTask({ provider: "ollama", model: "claude-opus-5" })[0].includes("use \"provider\": \"claude\""));
  ok(registry.get("claude").validateTask({ provider: "claude", model: "gpt-oss:20b-cloud" })[0].includes("not a Claude model"));
  deepEqual(registry.get("claude").validateTask({ provider: "claude", model: "claude-opus-5" }), []);
  deepEqual(registry.get("ollama").validateTask({ provider: "ollama", model: "gpt-oss:20b-cloud" }), []);
});

test("provider resolution rejects whitespace-only models and canonicalizes surrounding whitespace", () => {
  const registry = createProviderRegistry(defaultProviderAdapters());
  throws(() => registry.resolve({ model: "   ", provider: "claude" }, { config }), /non-empty model/);
  deepEqual(registry.resolve({ provider: "claude", model: "  claude-sonnet-5  " }, { config }), { provider: "claude", model: "claude-sonnet-5" });
});

test("a registered fourth provider resolves by id without a production branch", () => {
  const registry = createProviderRegistry(defaultProviderAdapters());
  registry.register({
    id: "fixture",
    runnerId: "fixture-runner",
    enabled: () => true,
    validateTask: () => [],
    capabilities: {},
  });
  deepEqual(registry.resolve({ provider: "fixture", model: "fixture-model" }, { config }), {
    provider: "fixture", model: "fixture-model",
  });
  throws(() => registry.resolve({ model: "fixture-model" }, { config }), /no "provider".*fixture/);
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
  equal(typeof registry.capability("claude", "preflight"), "function");
  equal(registry.capability("codex", "readUsage"), null);
  throws(() => registry.capability("codex", "invented"), /unknown provider capability/);
  throws(() => registry.register({
    id: "broken-capability",
    runnerId: "claude",
    enabled: () => true,
    validateTask: () => [],
    capabilities: { invented: () => {} },
  }), /unknown capability 'invented'/);
});

test("provider and runner identifiers reject mixed case and surrounding whitespace", () => {
  const base = {
    runnerId: "claude",
    enabled: () => true,
    validateTask: () => [],
    capabilities: {},
  };
  throws(() => createProviderRegistry([{ ...base, id: "Fixture" }]), /canonical lowercase identifier/);
  throws(() => createProviderRegistry([{ ...base, id: " fixture" }]), /canonical lowercase identifier/);
  throws(() => createProviderRegistry([{ ...base, id: "fixture", runnerId: "Claude" }]), /canonical lowercase identifier/);
});
