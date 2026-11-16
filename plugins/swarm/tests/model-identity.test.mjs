// Rows 5-8 of the validate-sanity test plan: a model string that cannot be a
// model, a provider mismatch, and roster membership.
import "./helpers/isolate-home.mjs";
import { test } from "node:test";
import { deepEqual, equal, ok, throws } from "node:assert/strict";
import { rmSync } from "node:fs";
import { createDefaultProviderRegistry, createProviderRegistry, defaultProviderAdapters } from "../src/providers.mjs";
import { defaultProviderRegistry } from "../src/default-providers.mjs";
import { resolveProvider } from "../src/manifest-model-gates.mjs";
import { checkModelIdentity } from "../src/model-identity.mjs";
import { loadManifest } from "./helpers/repo-io.mjs";
import { CFG, claudeTask, errorsOf, tmp, writeManifest } from "./helpers/manifest-fixtures.mjs";

const CONFIG = {
  providers: {
    claude: { enabled: true },
    ollama: { enabled: true },
    codex: { enabled: true },
  },
};

const resolve = (task) => createProviderRegistry(defaultProviderAdapters()).resolve(task, { config: CONFIG });

const DAY = 24 * 60 * 60_000;
const NOW = Date.UTC(2026, 10, 16);
const CATALOG = [
  { provider: "claude", model: "claude-opus-5" },
  { provider: "claude", model: "claude-sonnet-5" },
  { provider: "claude", model: "claude-haiku-5-5" },
];

// ── row 5: model shape ────────────────────────────────────────────────────────

test("row 5: a model carrying whitespace or a control character is refused", () => {
  for (const model of [
    "claude opus 5",
    "claude-opus-5\nsecond line",
    "claude-opus-5\u0007beep",
    "claude-opus-5\t",
    "  claude-opus-5",
    "claude-opus-5 ",
    // Trailing-only whitespace is the case a trim-first check would wave through.
    "claude-opus-5\n",
  ]) {
    throws(
      () => resolve({ model, provider: "claude" }),
      /not a model id — it carries whitespace or a control character/,
      JSON.stringify(model)
    );
  }
  deepEqual(resolve({ model: "claude-opus-5", provider: "claude" }), { provider: "claude", model: "claude-opus-5" });
});

test("row 5: a model over 200 characters is refused, quoting at most 60 of them", () => {
  throws(() => resolve({ model: "a".repeat(201), provider: "claude" }), /over the 200-character limit/);
  // 200 is the last length the rule permits; nothing else about it is judged here.
  equal(resolve({ model: "a".repeat(200), provider: "ollama" }).model.length, 200);

  let message = "";
  try {
    resolve({ model: "b".repeat(201), provider: "claude" });
  } catch (e) {
    message = e.message;
  }
  ok(message.includes("b".repeat(60)), message);
  ok(!message.includes("b".repeat(61)), `quotes more than 60 characters: ${message}`);
});

test("row 5: the shape refusal reaches a primary, a fallbackModel and the digest", () => {
  const dir = tmp();
  try {
    const primary = writeManifest(dir, { tasks: [claudeTask({ model: "claude opus 5" })] }, "primary.json");
    ok(errorsOf(() => loadManifest(primary, CFG, dir)).some((e) => e.includes("not a model id")), "primary");

    const fallback = writeManifest(dir, {
      tasks: [claudeTask({ fallbackProvider: "claude", fallbackModel: "claude-opus-5\n" })],
    }, "fallback.json");
    ok(errorsOf(() => loadManifest(fallback, CFG, dir)).some((e) => /fallback: model .*not a model id/.test(e)), "fallback");

    const digest = writeManifest(dir, {
      tasks: [claudeTask()],
      digest: { model: "claude-opus-5\n", provider: "claude" },
    }, "digest.json");
    ok(errorsOf(() => loadManifest(digest, CFG, dir)).some((e) => e.startsWith("digest: ") && e.includes("not a model id")), "digest");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── row 6: provider mismatch ──────────────────────────────────────────────────

test("row 6: a claude- id under ollama or codex is refused, by either codex adapter", () => {
  for (const registry of [createProviderRegistry(defaultProviderAdapters()), defaultProviderRegistry()]) {
    ok(registry.get("ollama").validateTask({ provider: "ollama", model: "claude-opus-5" }, { config: CONFIG })
      .some((p) => p.includes('use "provider": "claude"')), "ollama");
    ok(registry.get("codex").validateTask({ provider: "codex", model: "claude-opus-5" }, { config: CONFIG })
      .some((p) => p.includes('use "provider": "claude"')), "codex");
  }
});

test("row 6: a Codex model carrying an Ollama tag is refused", () => {
  const registry = defaultProviderRegistry();
  ok(registry.get("codex").validateTask({ provider: "codex", model: "deepseek-v4.1-flash:1017-cloud" }, { config: CONFIG })
    .some((p) => p.includes("Ollama tag")), "incident shape");
  deepEqual(registry.get("codex").validateTask({ provider: "codex", model: "gpt-5-codex" }, { config: CONFIG }), []);

  // The validate path: resolveProvider turns the adapter problem into a labelled error.
  const errors = [];
  resolveProvider({ model: "deepseek-v4.1-flash:1017-cloud", provider: "codex" }, CONFIG, [], "task 'x'", errors, registry);
  ok(errors.some((e) => e.startsWith("task 'x': ") && e.includes("Ollama tag")), errors.join("\n"));
});

// ── row 7: Claude membership ──────────────────────────────────────────────────

test("row 7: a fresh Claude catalog refuses an absent model, listing up to five ids", () => {
  const errors = [];
  const warnings = [];
  checkModelIdentity({
    model: "claude-opus-9", provider: "claude", cache: CATALOG,
    catalogFetchedAt: NOW - 2 * DAY, label: "task 'x'", errors, warnings, now: NOW,
  });
  equal(errors.length, 1);
  ok(errors[0].startsWith("task 'x': ") && errors[0].includes("2 days ago"), errors[0]);
  ok(errors[0].includes('"claude-opus-5"') && errors[0].includes('"claude-haiku-5-5"'), errors[0]);
  deepEqual(warnings, []);

  // A model the catalog lists is silent.
  const listed = { errors: [], warnings: [] };
  checkModelIdentity({
    model: "claude-opus-5", provider: "claude", cache: CATALOG,
    catalogFetchedAt: NOW - 2 * DAY, label: "task 'x'", ...listed, now: NOW,
  });
  deepEqual(listed.errors, []);
  deepEqual(listed.warnings, []);

  // At most five ids are named.
  const many = Array.from({ length: 8 }, (_, i) => ({ provider: "claude", model: `claude-m${i}` }));
  const crowded = { errors: [], warnings: [] };
  checkModelIdentity({
    model: "claude-absent", provider: "claude", cache: many,
    catalogFetchedAt: NOW - DAY, label: "task 'x'", ...crowded, now: NOW,
  });
  ok(crowded.errors[0].includes('"claude-m4"'), crowded.errors[0]);
  ok(!crowded.errors[0].includes('"claude-m5"'), crowded.errors[0]);
});

test("row 7: a catalog older than 7 days warns instead of refusing, naming its age", () => {
  const errors = [];
  const warnings = [];
  checkModelIdentity({
    model: "claude-opus-9", provider: "claude", cache: CATALOG,
    catalogFetchedAt: NOW - 9 * DAY, label: "task 'x'", errors, warnings, now: NOW,
  });
  deepEqual(errors, []);
  equal(warnings.length, 1);
  ok(warnings[0].includes("9 days old"), warnings[0]);
});

test("row 7: an empty Claude catalog checks nothing", () => {
  const errors = [];
  const warnings = [];
  checkModelIdentity({
    model: "claude-opus-9", provider: "claude", cache: [],
    catalogFetchedAt: NOW - DAY, label: "task 'x'", errors, warnings, now: NOW,
  });
  deepEqual(errors, []);
  deepEqual(warnings, []);
});

// ── row 8: Ollama/Codex membership ───────────────────────────────────────────

test("row 8: a model missing from a non-empty Ollama or Codex roster warns and still passes", () => {
  for (const provider of ["ollama", "codex"]) {
    const errors = [];
    const warnings = [];
    checkModelIdentity({
      model: "typo-model", provider, cache: [{ provider, model: "real-model" }],
      label: "task 'x'", errors, warnings, now: NOW,
    });
    deepEqual(errors, [], provider);
    equal(warnings.length, 1, provider);
    ok(warnings[0].includes("swarm models"), warnings[0]);

    const listed = { errors: [], warnings: [] };
    checkModelIdentity({
      model: "real-model", provider, cache: [{ provider, model: "real-model" }],
      label: "task 'x'", ...listed, now: NOW,
    });
    deepEqual(listed.errors, [], provider);
    deepEqual(listed.warnings, [], provider);
  }
});

test("row 8: an empty Ollama or Codex roster is silent", () => {
  for (const provider of ["ollama", "codex"]) {
    const errors = [];
    const warnings = [];
    checkModelIdentity({ model: "typo-model", provider, cache: [], label: "task 'x'", errors, warnings, now: NOW });
    deepEqual(errors, [], provider);
    deepEqual(warnings, [], provider);
  }
});
