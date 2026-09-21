import { test } from "node:test";
import { deepEqual, equal, ok, rejects, throws } from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join, sep } from "node:path";
import { tmpdir } from "node:os";
import { allowedRootsFor, createProviderRegistry, defaultProviderAdapters, probeProvider } from "../src/providers.mjs";
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

// ── allowedRootsFor: one resolution point for the two levels ──────────────────
// A provider entry may only ever REMOVE a root from the top-level list. It returns
// provenance, not a bare array: every operator-facing refusal has to name the key
// where the fix actually has an effect.

test("allowedRootsFor: a provider with no list of its own inherits the top-level one", () => {
  const cfg = { allowedRoots: ["C:/code"], providers: { ollama: { enabled: true } } };
  deepEqual(allowedRootsFor(cfg, "ollama").roots, ["C:/code"]);
  equal(allowedRootsFor(cfg, "ollama").deniedBy, "allowedRoots");
});

test("allowedRootsFor: a provider entry narrows the top-level list", () => {
  const cfg = {
    allowedRoots: ["C:/code", "C:/work"],
    providers: { ollama: { allowedRoots: ["C:/work"] } },
  };
  deepEqual(allowedRootsFor(cfg, "ollama").roots, ["C:/work"]);
  equal(allowedRootsFor(cfg, "ollama").deniedBy, "providers.ollama.allowedRoots");
});

// The widening half — the one an override implementation passes and intersection must not.
// RED against an override: the provider's own list alone would be returned, granting C:/personal.
test("allowedRootsFor: a provider entry can never widen — a root the top level withheld grants nothing", () => {
  const cfg = { allowedRoots: ["C:/code"], providers: { ollama: { allowedRoots: ["C:/personal"] } } };
  deepEqual(allowedRootsFor(cfg, "ollama").roots, []);
});

// The intersection keeps the NARROWER side by containment. isUnderRoot is asymmetric, so
// "keep the provider's entry when either contains the other" hands back the whole drive —
// and a set-style equality intersection drops the pair entirely, which looks fail-closed
// and passes any row that only asserts "refused".
test("allowedRootsFor: the intersection keeps the narrower root, not the wider one", () => {
  const dir = mkdtempSync(join(tmpdir(), "swarm-roots-"));
  try {
    const narrow = join(dir, "code");
    // Provider is the WIDER side: tmpdir() contains tmpdir()/code.
    deepEqual(
      allowedRootsFor({ allowedRoots: [narrow], providers: { ollama: { allowedRoots: [dir] } } }, "ollama").roots,
      [narrow],
    );
    // Provider is the NARROWER side: the top-level list keeps the whole directory.
    deepEqual(
      allowedRootsFor({ allowedRoots: [dir], providers: { ollama: { allowedRoots: [narrow] } } }, "ollama").roots,
      [narrow],
    );
    // The plan's own shape: a provider naming the drive root must not widen past C:/code.
    deepEqual(
      allowedRootsFor({ allowedRoots: ["C:/code"], providers: { ollama: { allowedRoots: ["C:/"] } } }, "ollama").roots,
      ["C:/code"],
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// Raw string equality is not an intersection: C:\code, C:/code and c:/code/ are one root.
test("allowedRootsFor: the intersection compares normalised paths, not raw strings", () => {
  const dir = mkdtempSync(join(tmpdir(), "swarm-roots-"));
  try {
    const variants = [dir + sep, dir + `${sep}.${sep}`, dir + sep + sep];
    if (process.platform === "win32") variants.push(dir.toUpperCase(), dir.replace(/\//g, "\\"));
    for (const variant of variants) {
      const { roots } = allowedRootsFor({ allowedRoots: [dir], providers: { ollama: { allowedRoots: [variant] } } }, "ollama");
      equal(roots.length, 1, `'${variant}' did not intersect '${dir}'`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// #302 made the two refusals say different things: absent means never configured, [] means
// the operator denied it. A helper that coalesces one into the other passes any assertion
// that only checks "refused", and silently rewrites the operator's own message.
test("allowedRootsFor: undefined (inherit) stays distinguishable from [] (denial)", () => {
  equal(allowedRootsFor({ providers: { ollama: { enabled: true } } }, "ollama").roots, undefined);
  deepEqual(allowedRootsFor({ allowedRoots: [], providers: { ollama: { enabled: true } } }, "ollama").roots, []);
  deepEqual(
    allowedRootsFor({ allowedRoots: ["C:/code"], providers: { ollama: { allowedRoots: [] } } }, "ollama").roots,
    [],
  );
});

// The compatibility floor: every config in the wild carries only per-provider keys. With no
// top-level key there is nothing to intersect, so the provider's own list comes back verbatim.
test("allowedRootsFor: a config with only per-provider keys resolves exactly as it did before", () => {
  const legacy = { provider: { allowedRoots: ["C:/code"] } };
  deepEqual(allowedRootsFor(legacy, "ollama").roots, ["C:/code"]);
  equal(allowedRootsFor(legacy, "ollama").deniedBy, "provider.allowedRoots");

  const canonical = { providers: { codex: { allowedRoots: ["C:/codex"] } } };
  deepEqual(allowedRootsFor(canonical, "codex").roots, ["C:/codex"]);
  equal(allowedRootsFor(canonical, "codex").deniedBy, "providers.codex.allowedRoots");
});

// ── the probe: setup asks "can this provider dispatch right now?" ─────────────

const ollamaCfg = (url) => ({ providers: { ollama: { url } } });

test("probe: a reachable endpoint reports ok, and the request carries the configured url", async () => {
  const seen = [];
  const r = await probeProvider("ollama", {
    config: ollamaCfg("http://127.0.0.1:11434"),
    fetch: async (url) => { seen.push(String(url)); return { ok: true }; },
  });
  deepEqual(r, { id: "ollama", ok: true, detail: null, probed: true });
  deepEqual(seen, ["http://127.0.0.1:11434"]);
});

// setup renders the probe result as the content of its question, so "passed" and
// "never asked" must not be the same answer: detail is null in both, and a caller
// reading only that would tell the operator "codex — answered" about a provider the
// engine has no preflight for.
test("probe: a provider with no preflight reports probed:false, distinct from one that passed", async () => {
  deepEqual(await probeProvider("codex", { config: {} }), { id: "codex", ok: true, detail: null, probed: false });
  const r = await probeProvider("ollama", {
    config: ollamaCfg("http://127.0.0.1:11434"),
    fetch: async () => ({ ok: true }),
  });
  deepEqual(r, { id: "ollama", ok: true, detail: null, probed: true });
});

// The setup one-liner has nothing but a config to hand over — there is no fetch to
// inject on a command line. Un-injected, the probe threw "fetch is not a function",
// which probeProvider's catch renders as ok:false: a REFUSAL for a route that was
// never tried, and setup offering to disable a provider that works.
test("probe: with no fetch injected the probe uses the global, not a false refusal", async () => {
  const real = globalThis.fetch;
  const seen = [];
  globalThis.fetch = async (url) => { seen.push(String(url)); return { ok: true }; };
  let r;
  try {
    r = await probeProvider("ollama", { config: ollamaCfg("http://127.0.0.1:11434") });
  } finally { globalThis.fetch = real; }
  deepEqual(r, { id: "ollama", ok: true, detail: null, probed: true });
  deepEqual(seen, ["http://127.0.0.1:11434"]);
});

test("probe: a refused endpoint reports the refusal, keeping the word the dispatch path matches on", async () => {
  const r = await probeProvider("ollama", {
    config: ollamaCfg("http://127.0.0.1:11434"),
    fetch: async () => { throw new Error("ECONNREFUSED"); },
  });
  equal(r.ok, false);
  ok(r.detail.includes("unreachable"), r.detail);
  ok(r.detail.includes("ECONNREFUSED"), r.detail);
});

// The one that matters for setup: a probe with no timeout hangs the command that
// ran it. Assert the probe RESOLVES, never that it was fast — an elapsed-time
// assertion on a machine under load is a coin flip.
test("probe: an endpoint that never answers still resolves, reporting the timeout not a refusal", async () => {
  const r = await probeProvider("ollama", {
    config: ollamaCfg("http://127.0.0.1:11434"),
    timeoutMs: 25,
    fetch: () => new Promise(() => {}),
  });
  equal(r.ok, false);
  ok(r.detail.includes("did not answer"), r.detail);
  ok(!r.detail.includes("unreachable"), `a timeout is not a refusal — the two route to different fixes: ${r.detail}`);
});

// The preflight capability throws by contract (preflightClaude does, on quota
// exhaustion). A probe that lets that escape takes the whole setup command with it.
test("probe: a preflight that throws is caught, and its message becomes the detail", async () => {
  const registry = createProviderRegistry([{
    id: "ollama",
    runnerId: "claude",
    enabled: () => true,
    validateTask: () => [],
    capabilities: { preflight: () => { throw new Error("quota exploded"); } },
  }]);
  deepEqual(await probeProvider("ollama", { config: {}, registry }), { id: "ollama", ok: false, detail: "quota exploded", probed: true });
});

// The positive half of the same contract: a capability that REPORTS failure rather
// than throwing keeps its own error text, so setup shows the operator the real cause.
test("probe: a preflight reporting ok:false keeps its own error text", async () => {
  const registry = createProviderRegistry([{
    id: "ollama",
    runnerId: "claude",
    enabled: () => true,
    validateTask: () => [],
    capabilities: { preflight: async () => ({ ok: false, error: "endpoint refused" }) },
  }]);
  deepEqual(await probeProvider("ollama", { config: {}, registry }), { id: "ollama", ok: false, detail: "endpoint refused", probed: true });
});
