// Provider identity and provider-shape policy: which provider a task dispatches on,
// what each provider accepts, and the governance that gates both.
import { test } from "node:test";
import { equal, ok, deepEqual } from "node:assert/strict";
import { rmSync } from "node:fs";
import { basename } from "node:path";
import { loadManifest } from "./helpers/repo-io.mjs";
import { CFG, writeManifest, tmp, errorsOf, claudeTask } from "./helpers/manifest-fixtures.mjs";

test("fallbackModel: governed like the primary; passes through to the task", () => {
  const dir = tmp();
  try {
    // open-model fallback outside allowedRoots -> validation error
    const p1 = writeManifest(dir, { tasks: [claudeTask({ fallbackProvider: "ollama", fallbackModel: "glm-4.6:cloud" })] });
    const errs = errorsOf(() => loadManifest(p1, CFG, dir));
    ok(errs.some((e) => e.includes("fallback") && e.includes("governance")), errs.join("\n"));

    // claude fallback is fine anywhere and lands on the normalized task
    const p2 = writeManifest(dir, { tasks: [claudeTask({ provider: "claude", model: "claude-sonnet-5", fallbackProvider: "claude", fallbackModel: "claude-haiku-4-5-20251001" })] }, "ok.json");
    const plan = loadManifest(p2, CFG, dir);
    equal(plan.tasks[0].fallbackModel, "claude-haiku-4-5-20251001");
    equal(plan.tasks[0].fallbackProvider, "claude");

    // non-string fallback rejected
    const p3 = writeManifest(dir, { tasks: [claudeTask({ fallbackModel: 42 })] }, "bad.json");
    ok(errorsOf(() => loadManifest(p3, CFG, dir)).some((e) => e.includes("fallbackModel")), "type error surfaced");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("provider identity: an explicit provider persists; nothing is inferred from the model name or the cache", () => {
  const dir = tmp();
  try {
    const cfg = {
      ...CFG,
      providers: {
        claude: { enabled: true, allowedRoots: [dir] },
        ollama: { enabled: true, allowedRoots: [dir] },
        codex: { enabled: true, allowedRoots: [dir] },
      },
    };
    const explicitPath = writeManifest(dir, {
      tasks: [{ id: "codex", prompt: "inspect", model: "gpt-5-codex", provider: "codex", fallbackProvider: "claude", fallbackModel: "claude-haiku-4-5-20251001" }],
      digest: { model: "gpt-5-codex", provider: "codex" },
    }, "explicit.json");
    const explicit = loadManifest(explicitPath, cfg, dir);
    equal(explicit.tasks[0].provider, "codex");
    equal(explicit.tasks[0].fallbackProvider, "claude");
    equal(explicit.digest.provider, "codex");

    // A discovery-cache row no longer stands in for the field: naming the model alone is refused.
    const bareCodexPath = writeManifest(dir, {
      tasks: [{ id: "bare", prompt: "inspect", model: "gpt-5-codex" }],
    }, "bare.json");
    const bareErrs = errorsOf(() => loadManifest(bareCodexPath, cfg, dir, { cache: [{ provider: "codex", model: "gpt-5-codex" }] }));
    ok(bareErrs.some((e) => e.includes("task 'bare'") && e.includes("no \"provider\"")), bareErrs.join("\n"));

    // ...and a model no provider has heard of is no longer swept onto Ollama.
    const typoPath = writeManifest(dir, {
      tasks: [{ id: "typo", prompt: "inspect", model: "sonnet-4-5-typo" }],
    }, "typo.json");
    ok(errorsOf(() => loadManifest(typoPath, cfg, dir)).some((e) => e.includes("no \"provider\"")));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("manifest provider field permits the same model on two dispatch providers", () => {
  const dir = tmp();
  try {
    const cfg = {
      ...CFG,
      providers: {
        claude: { enabled: true },
        ollama: { enabled: true, allowedRoots: [dir] },
        codex: { enabled: true, allowedRoots: [dir] },
      },
    };
    const p = writeManifest(dir, {
      tasks: [
        { id: "ollama", prompt: "inspect", model: "same-model", provider: "ollama" },
        { id: "codex", prompt: "inspect", model: "same-model", provider: "codex" },
      ],
    }, "same-model.json");
    const plan = loadManifest(p, cfg, dir);
    deepEqual(plan.tasks.map((task) => ({ id: task.id, model: task.model, provider: task.provider })), [
      { id: "ollama", model: "same-model", provider: "ollama" },
      { id: "codex", model: "same-model", provider: "codex" },
    ]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("provider policy: Codex rejects Claude settings and configured leaf guards unless opted out", () => {
  const dir = tmp();
  try {
    const cfg = {
      ...CFG,
      providers: { claude: { enabled: true }, ollama: { enabled: true, allowedRoots: [] }, codex: { enabled: true, allowedRoots: [dir] } },
      projects: [{ name: basename(dir), hooks: { preToolUse: "guard-cmd" } }],
    };
    const guarded = writeManifest(dir, {
      tasks: [{ id: "codex", prompt: "inspect", model: "gpt-5-codex", provider: "codex", settings: { env: { X: "1" } } }],
    }, "guarded.json");
    const errs = errorsOf(() => loadManifest(guarded, cfg, dir, {
      io: { repoToplevel: () => dir, spawnSync: () => ({ status: 0, stderr: "" }), stdout: () => {}, platform: process.platform },
    }));
    ok(errs.some((e) => /Codex tasks do not accept Claude-only settings/.test(e)), errs.join("\n"));
    ok(errs.some((e) => /leaf guard/i.test(e) && /codex/i.test(e)), errs.join("\n"));

    const optedOut = writeManifest(dir, {
      tasks: [{ id: "codex", prompt: "inspect", model: "gpt-5-codex", provider: "codex", leafGuard: false }],
    }, "opted-out.json");
    const plan = loadManifest(optedOut, cfg, dir, {
      io: { repoToplevel: () => dir, spawnSync: () => ({ status: 0, stderr: "" }), stdout: () => {}, platform: process.platform },
    });
    equal(plan.tasks[0].provider, "codex");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("contextWindow accepts only 1m and stays on the normalized task", () => {
  const dir = tmp();
  try {
    const cfg = { ...CFG, provider: { allowedRoots: [dir] } };
    const okPath = writeManifest(dir, {
      tasks: [{ id: "cloud", prompt: "inspect", provider: "ollama", model: "glm-5.3:cloud", contextWindow: "1m" }],
    }, "ok.json");
    const plan = loadManifest(okPath, cfg, dir);
    equal(plan.tasks[0].contextWindow, "1m");

    const badPath = writeManifest(dir, {
      tasks: [{ id: "cloud", prompt: "inspect", provider: "ollama", model: "glm-5.3:cloud", contextWindow: "512k" }],
    }, "bad.json");
    const errs = errorsOf(() => loadManifest(badPath, cfg, dir));
    ok(errs.some((e) => e.includes("contextWindow") && e.includes('"1m"') && e.includes('"contextWindow": "1m"')), errs.join("\n"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("contextWindow refuses Ollama launch mode and Codex tasks", () => {
  const dir = tmp();
  try {
    const launchCfg = {
      ...CFG,
      provider: { allowedRoots: [dir], mode: "launch", launchCmd: "ollama launch claude --model {model} -- {args}" },
    };
    const launchPath = writeManifest(dir, {
      tasks: [{ id: "cloud", prompt: "inspect", provider: "ollama", model: "glm-5.3:cloud", contextWindow: "1m" }],
    }, "launch.json");
    const launchErrs = errorsOf(() => loadManifest(launchPath, launchCfg, dir));
    ok(launchErrs.some((e) => e.includes("contextWindow") && e.includes("launch mode") && e.includes("[1m]")), launchErrs.join("\n"));

    const codexCfg = {
      ...CFG,
      providers: { claude: { enabled: true }, ollama: { enabled: true, allowedRoots: [dir] }, codex: { enabled: true, allowedRoots: [dir] } },
    };
    const codexPath = writeManifest(dir, {
      tasks: [{ id: "codex", prompt: "inspect", model: "gpt-5-codex", provider: "codex", contextWindow: "1m" }],
    }, "codex.json");
    const codexErrs = errorsOf(() => loadManifest(codexPath, codexCfg, dir));
    ok(codexErrs.some((e) => /Codex tasks do not support contextWindow/.test(e)), codexErrs.join("\n"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("provider is required: fallback, digest, unknown ids and aliases are each refused; compute steps stay exempt", () => {
  const dir = tmp();
  try {
    const errs = (body) => errorsOf(() => loadManifest(writeManifest(dir, body), CFG, dir));
    const has = (list, ...needles) => ok(list.some((e) => needles.every((n) => e.includes(n))), list.join("\n"));

    has(errs({ tasks: [{ id: "a", prompt: "x", model: "claude-opus-5" }] }), "task 'a'", "no \"provider\"");
    has(errs({ tasks: [claudeTask({ fallbackModel: "claude-sonnet-5" })] }), "fallbackModel", "fallbackProvider");
    has(errs({ tasks: [claudeTask({ fallbackProvider: "claude" })] }), "fallbackProvider", "fallbackModel");
    has(errs({ tasks: [claudeTask(), claudeTask({ id: "b" })], digest: { model: "claude-haiku-4-5-20251001" } }), "digest", "no \"provider\"");
    has(errs({ tasks: [claudeTask({ provider: "nope" })] }), "unknown provider 'nope'", "registered: claude, ollama, codex");
    has(errs({ tasks: [claudeTask({ model: "sonnet" })] }), "Claude alias");
    has(errs({ tasks: [claudeTask({ fallbackModel: "haiku", fallbackProvider: "claude" })] }), "Claude alias");

    // compute nodes dispatch nothing, so they carry neither model nor provider.
    const plan = loadManifest(writeManifest(dir, {
      tasks: [claudeTask({ id: "scan" }), { id: "dedupe", after: ["scan"], compute: "deps['scan']" }],
    }), CFG, dir);
    equal(plan.tasks.find((t) => t.id === "dedupe").compute, "deps['scan']");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
