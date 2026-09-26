import { test } from "node:test";
import { equal, ok } from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { modelDescriptor } from "../src/contracts.mjs";
import { loadConfig } from "../src/config.mjs";
import { defaultProviderRegistry } from "../src/default-providers.mjs";
import { effortsCell } from "../src/model-row.mjs";
import { cmdModels } from "../scripts/swarm.mjs";

// Same shape as tests/fixtures/fourth-provider.mjs, parameterised over the
// descriptors the discovery capability returns.
function effortProvider(descriptors) {
  return {
    id: "fixture",
    runnerId: "fixture",
    enabled: (cfg) => cfg.providers?.fixture?.enabled === true,
    validateTask: () => [],
    capabilities: { discoverModels: async () => descriptors },
  };
}

function effortConfig(root) {
  return {
    providers: {
      claude: { enabled: true },
      ollama: { enabled: false, allowedRoots: [] },
      codex: { enabled: false, allowedRoots: [] },
      fixture: { enabled: true, allowedRoots: [root] },
    },
    concurrency: 1,
  };
}

async function modelLines(descriptors, rest = []) {
  const home = mkdtempSync(join(tmpdir(), "swarm-efforts-"));
  // HOME too, not just SWARM_HOME: the claude adapter's discoverModels reads
  // ~/.claude/cache/model-catalog, so a real one would add rows this roster asserts against.
  const env = { ...process.env, SWARM_HOME: home, HOME: home, USERPROFILE: home };
  const registry = defaultProviderRegistry({ additionalProviders: [effortProvider(descriptors)] });
  const lines = [];
  try {
    equal(await cmdModels(rest, { cfg: effortConfig(home), env, registry, fetchImpl: async () => ({ ok: true }), write: (line) => lines.push(line) }), 0);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
  return lines;
}

test("swarm models renders each row's declared efforts", async () => {
  const lines = await modelLines([
    modelDescriptor({ provider: "fixture", model: "declares-list", runner: "fixture", efforts: ["low", "medium", "high"] }),
  ]);
  const line = lines.find((l) => l.includes("declares-list"));
  ok(line && line.includes("low/medium/high"), lines.join("\n"));
});

// claude-haiku-4-5-20251001 is the real case: thinking.type "none", no effort
// options — the row is present, the declaration is not. In words, never a blank.
test("a row that declares no efforts renders the words, not an empty cell", async () => {
  const lines = await modelLines([
    modelDescriptor({ provider: "fixture", model: "declares-none", runner: "fixture" }),
    modelDescriptor({ provider: "fixture", model: "declares-empty", runner: "fixture", efforts: [] }),
  ]);
  const noneLine = lines.find((l) => l.includes("declares-none"));
  ok(noneLine && noneLine.includes("declares none"), lines.join("\n"));
  const emptyLine = lines.find((l) => l.includes("declares-empty"));
  ok(emptyLine && emptyLine.includes("declares none"), lines.join("\n"));
});

// "We have not looked" is a model with no roster row at all — the state a
// session cannot act on and must not mistake for a declaration of none.
test("a model with no roster row renders unknown, distinct from declares none", () => {
  equal(effortsCell({ model: "unseen", provider: "fixture" }, []), "unknown");
  equal(effortsCell({ model: "unseen", provider: "fixture" }, [{ model: "other", provider: "fixture" }]), "unknown");
  const present = effortsCell({ model: "present", provider: "fixture" }, [{ model: "present", provider: "fixture" }]);
  ok(present.includes("declares none"), present);
  ok(present !== "unknown", present);
});

// defaultEffort is declaredEfforts' own output field — the raw efforts field
// does not carry it, so a column reading the cache field directly loses it.
// claude-* rows are the real case (default from the catalog badge).
test("a declared default effort renders beside the list and stands alone", async () => {
  const lines = await modelLines([
    modelDescriptor({ provider: "fixture", model: "default-with-list", runner: "fixture", efforts: ["low", "high"], defaultEffort: "low" }),
    modelDescriptor({ provider: "fixture", model: "default-only", runner: "fixture", defaultEffort: "medium" }),
  ]);
  const listLine = lines.find((l) => l.includes("default-with-list"));
  ok(listLine && listLine.includes("low/high (default low)"), lines.join("\n"));
  const onlyLine = lines.find((l) => l.includes("default-only"));
  ok(onlyLine && onlyLine.includes("default medium"), lines.join("\n"));
});

// Item 16: the Codex and Claude rosters were never collapsed, so a superseded
// generation printed beside the model that replaced it. `--all` still lists
// them, marked — the same rule the Ollama roster already followed.
test("a superseded Codex/Claude row leaves the roster until --all, which marks it", async () => {
  const descriptors = [
    "gpt-5.6-luna", "gpt-6-luna", "gpt-5.6-sol", "gpt-6-sol", "gpt-5.6-terra", "gpt-5.5",
    "claude-opus-4-8", "claude-opus-5",
  ].map((model) => modelDescriptor({ provider: "fixture", model, runner: "fixture" }));

  const shown = await modelLines(descriptors);
  const text = shown.join("\n");
  for (const gone of ["gpt-5.6-luna", "gpt-5.6-sol", "claude-opus-4-8"]) {
    ok(!text.includes(gone), `${gone} is superseded and must not print by default:\n${text}`);
  }
  for (const kept of ["gpt-6-luna", "gpt-6-sol", "gpt-5.6-terra", "gpt-5.5", "claude-opus-5"]) {
    ok(text.includes(kept), `${kept} has no newer sibling and must stay:\n${text}`);
  }

  const all = (await modelLines(descriptors, ["--all"])).join("\n");
  ok(/gpt-5\.6-luna.*\[superseded by gpt-6-luna\]/.test(all), `--all must list it, marked:\n${all}`);
  ok(/claude-opus-4-8.*\[superseded by claude-opus-5\]/.test(all), `--all must list it, marked:\n${all}`);
});

// R8: `swarm models` is step 1 of the skill's procedure, so a fresh install meets an empty
// roster before it ever meets a validation refusal. Silence there is a dead end, not a route.
test("R8: with no config file the empty roster names /swarm:swarm setup", async () => {
  const home = mkdtempSync(join(tmpdir(), "swarm-noconfig-"));
  const env = { ...process.env, SWARM_HOME: home, HOME: home, USERPROFILE: home };
  const lines = [];
  try {
    // The real load path, not a fixture: no ~/.swarm/config.json means the shipped default,
    // which enables nothing and sets no roots.
    const cfg = loadConfig(join(home, "config.json"), env);
    equal(await cmdModels([], { cfg, env, registry: defaultProviderRegistry(), fetchImpl: async () => ({ ok: true }), write: (line) => lines.push(line) }), 0);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
  const text = lines.join("\n");
  ok(text.includes("/swarm:swarm setup"), `an unconfigured install must be routed to setup:\n${text}`);
});

test("R8: a launchable roster carries no setup sentence", async () => {
  const text = (await modelLines([modelDescriptor({ provider: "fixture", model: "glm-5.2:cloud", runner: "fixture" })])).join("\n");
  ok(!text.includes("/swarm:swarm setup"), text);
});
