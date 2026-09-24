import { test } from "node:test";
import { equal, ok, deepEqual, throws, match } from "node:assert/strict";
import { writeFileSync, readFileSync, rmSync, mkdirSync } from "node:fs";
import { join, sep } from "node:path";
import { tmpdir } from "node:os";
import { ValidationError, DEFAULT_TOOLS, isUnderRoot, hasWriteTools, guardFor } from "../src/manifest.mjs";
import { buildDigestTask } from "../src/digest.mjs";
import { loadManifest } from "./helpers/repo-io.mjs";
import { CFG, writeManifest, tmp, errorsOf, claudeTask } from "./helpers/manifest-fixtures.mjs";
import { getUsage, resetUsageMemo, saveCookie } from "../src/ollama-usage.mjs";
import { integrateCaps } from "../src/estimate.mjs";

// A tree follows from write tools, so every test that wants one asks for them.
const writerTask = (over = {}) => claudeTask({ allowedTools: "Read,Edit,Bash", ...over });

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

test("fully valid manifest normalizes with defaults", () => {
  const dir = tmp();
  try {
    const p = writeManifest(dir, {
      resultsDir: "out",
      tasks: [
        { id: "scan-a", prompt: "look", provider: "claude", model: "claude-haiku-4-5-20251001" },
        { id: "scan-b", prompt: "look more", provider: "claude", model: "claude-sonnet-5", effort: "max" },
        { id: "join", prompt: "combine {{result:scan-a}} and {{resultPath:scan-b}}", provider: "claude", model: "claude-opus-5", after: ["scan-a", "scan-b"] },
      ],
      digest: { provider: "claude", model: "claude-haiku-4-5-20251001", instructions: "focus on X" },
    });
    const plan = loadManifest(p, CFG, dir);
    equal(plan.resultsDir, join(dir, "out"));
    equal(plan.concurrency, 4);
    equal(plan.tasks.length, 3);
    equal(plan.tasks[0].allowedTools, DEFAULT_TOOLS);
    equal(plan.tasks[0].cwd, dir);
    equal(plan.tasks[0].timeoutMs, 600000);
    deepEqual(plan.tasks[2].after, ["scan-a", "scan-b"]);
    equal(plan.digest.model, "claude-haiku-4-5-20251001");
    equal(plan.digest.instructions, "focus on X");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("settings must be a JSON object", () => {
  const dir = tmp();
  try {
    const p1 = writeManifest(dir, { tasks: [claudeTask({ settings: "x" })] });
    const errs = errorsOf(() => loadManifest(p1, CFG, dir));
    ok(errs.some((e) => e.includes("settings must be a JSON object")), errs.join("\n"));

    const p2 = writeManifest(dir, { tasks: [claudeTask({ settings: { env: {} } })] }, "ok.json");
    const plan = loadManifest(p2, CFG, dir);
    deepEqual(plan.tasks[0].settings, { env: {} });
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

test("settings.env cannot forge or clear the leaf guard vars", () => {
  const dir = tmp();
  try {
    for (const key of ["SWARM_LEAF", "SWARM_LEAF_GUARD", "SWARM_LEAF_GUARD_PROJECT"]) {
      const p = writeManifest(dir, { tasks: [claudeTask({ settings: { env: { [key]: "" } } })] });
      const errs = errorsOf(() => loadManifest(p, CFG, dir));
      ok(errs.some((e) => e.includes("settings.env") && e.includes(key)), `${key}: ${errs.join("\n")}`);
    }

    // an unrelated key survives untouched
    const ok1 = writeManifest(dir, { tasks: [claudeTask({ settings: { env: { OTHER: "x" } } })] }, "ok.json");
    const plan = loadManifest(ok1, CFG, dir);
    deepEqual(plan.tasks[0].settings, { env: { OTHER: "x" } });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("duplicate ids rejected", () => {
  const dir = tmp();
  try {
    const p = writeManifest(dir, { tasks: [claudeTask(), claudeTask()] });
    const errs = errorsOf(() => loadManifest(p, CFG, dir));
    ok(errs.some((e) => e.includes("duplicate id")), errs.join("|"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("non-filename-safe and reserved ids rejected", () => {
  const dir = tmp();
  try {
    const p = writeManifest(dir, {
      tasks: [
        claudeTask({ id: "bad/id" }),
        claudeTask({ id: "__digest" }),
      ],
    });
    const errs = errorsOf(() => loadManifest(p, CFG, dir));
    ok(errs.some((e) => e.includes("filename-safe")));
    ok(errs.some((e) => e.includes("reserved")));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("missing prompt/model reported", () => {
  const dir = tmp();
  try {
    const p = writeManifest(dir, { tasks: [{ id: "a" }] });
    const errs = errorsOf(() => loadManifest(p, CFG, dir));
    ok(errs.some((e) => e.includes("prompt is required")));
    ok(errs.some((e) => e.includes("model is required")));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("unknown after id rejected", () => {
  const dir = tmp();
  try {
    const p = writeManifest(dir, { tasks: [claudeTask({ after: ["ghost"] })] });
    const errs = errorsOf(() => loadManifest(p, CFG, dir));
    ok(errs.some((e) => e.includes("unknown dependency 'ghost'")));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("dependency cycle rejected", () => {
  const dir = tmp();
  try {
    const p = writeManifest(dir, {
      tasks: [
        claudeTask({ id: "a", after: ["b"] }),
        claudeTask({ id: "b", after: ["a"] }),
      ],
    });
    const errs = errorsOf(() => loadManifest(p, CFG, dir));
    ok(errs.some((e) => e.includes("cycle")), errs.join("|"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("template ref to a non-dependency id rejected", () => {
  const dir = tmp();
  try {
    const p = writeManifest(dir, {
      tasks: [
        claudeTask({ id: "a" }),
        claudeTask({ id: "b", prompt: "use {{result:a}} and {{resultPath:c}}", after: [] }),
        claudeTask({ id: "c" }),
      ],
    });
    const errs = errorsOf(() => loadManifest(p, CFG, dir));
    ok(errs.some((e) => e.includes("{{result:a}}")), errs.join("|"));
    ok(errs.some((e) => e.includes("{{resultPath:c}}")), errs.join("|"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("effort resolves from the manifest, provider declaration, or medium", () => {
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
    const good = writeManifest(dir, {
      tasks: [
        { id: "c", prompt: "p", model: "gpt-5.5", provider: "codex" },
        { id: "s", prompt: "p", model: "claude-sonnet-5", provider: "claude", effort: "xhigh" },
        { id: "h", prompt: "p", model: "claude-haiku-4-5-20251001", provider: "claude", effort: "max" },
        { id: "u", prompt: "p", model: "claude-opus-4-8", provider: "claude", effort: "max" },
      ],
    }, "good.json");
    const plan = loadManifest(good, cfg, dir, {
      cache: [
        { provider: "codex", model: "gpt-5.5", efforts: ["low", "medium", "high", "xhigh"] },
        { provider: "claude", model: "claude-sonnet-5", efforts: ["low", "medium", "high", "xhigh", "max"], defaultEffort: "high" },
        { provider: "claude", model: "claude-haiku-4-5-20251001", defaultEffort: undefined },
      ],
    });
    equal(plan.tasks.find((t) => t.id === "c").effort, "medium");
    equal(plan.tasks.find((t) => t.id === "s").effort, "xhigh");
    equal(plan.tasks.find((t) => t.id === "h").effort, "max");
    equal(plan.tasks.find((t) => t.id === "u").effort, "max");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("declared effort contradictions name the model and allowed values, including fallback", () => {
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
    const cache = [{ provider: "codex", model: "gpt-5.5", efforts: ["low", "medium", "high", "xhigh"] }];
    const path = writeManifest(dir, {
      tasks: [claudeTask({ model: "claude-sonnet-5", effort: "max", fallbackModel: "gpt-5.5", fallbackProvider: "codex" })],
    });
    const errors = errorsOf(() => loadManifest(path, cfg, dir, { cache }));
    ok(errors.some((e) => e.includes("gpt-5.5") && e.includes("low, medium, high, xhigh")), errors.join("\n"));

    const xhigh = writeManifest(dir, {
      tasks: [{ id: "g", prompt: "p", model: "gpt-5.5", provider: "codex", effort: "xhigh" }],
    }, "xhigh.json");
    equal(loadManifest(xhigh, cfg, dir, { cache }).tasks[0].effort, "xhigh");

    const empty = writeManifest(dir, {
      tasks: [claudeTask({ effort: "" })],
    }, "empty.json");
    ok(errorsOf(() => loadManifest(empty, cfg, dir)).some((e) => /effort must be a non-empty string/.test(e)));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("compute, manifest, and integrate nodes carry no effort", () => {
  const dir = tmp();
  try {
    const child = writeManifest(dir, { tasks: [claudeTask({ id: "child" })] }, "child.json");
    const path = writeManifest(dir, {
      tasks: [
        { id: "compute", compute: "1 == 1" },
        { id: "writer", prompt: "write", provider: "claude", model: "claude-haiku-4-5-20251001", allowedTools: "Read,Edit" },
        { id: "integrate", after: ["writer"], integrate: { into: "feat", from: ["writer"] } },
        { id: "manifest", manifest: child },
      ],
    }, "agentless.json");
    const plan = loadManifest(path, CFG, dir);
    equal(plan.tasks.find((t) => t.id === "compute").effort, undefined);
    equal(plan.tasks.find((t) => t.id === "integrate").effort, undefined);
    equal(plan.tasks.find((t) => t.id === "manifest").effort, undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("digest.report: true and a steering string both survive to the plan", () => {
  const dir = tmp();
  try {
    const p = writeManifest(dir, {
      tasks: [claudeTask()],
      digest: { provider: "claude", model: "claude-haiku-4-5-20251001", report: true },
    });
    equal(loadManifest(p, CFG, dir).digest.report, true);

    const p2 = writeManifest(dir, {
      tasks: [claudeTask()],
      digest: { provider: "claude", model: "claude-haiku-4-5-20251001", report: "Lead with the security findings." },
    }, "plan2.json");
    equal(loadManifest(p2, CFG, dir).digest.report, "Lead with the security findings.");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("digest.report rejects a non-boolean, non-string value", () => {
  const dir = tmp();
  try {
    const p = writeManifest(dir, {
      tasks: [claudeTask()],
      digest: { provider: "claude", model: "claude-haiku-4-5-20251001", report: 3 },
    });
    const errs = errorsOf(() => loadManifest(p, CFG, dir));
    ok(errs.some((e) => e.includes("digest.report")), errs.join("|"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// digest.instructions already gets args substitution; without the same treatment
// a {{args.x}} in the report steer survives verbatim into the leaf's prompt.
// The goal flows into the digest prompt and titles the report — an un-substituted
// {{args.x}} there disfigured every report's H1 (the live-run bug).
test("args substitute into the goal", () => {
  const dir = tmp();
  try {
    const p = writeManifest(dir, {
      goal: "audit the {{args.area}} surface",
      tasks: [claudeTask({ prompt: "look at {{args.area}}" })],
    });
    const plan = loadManifest(p, CFG, dir, { args: { area: "auth" } });
    equal(plan.goal, "audit the auth surface");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("args substitute into the digest.report steering string", () => {
  const dir = tmp();
  try {
    const p = writeManifest(dir, {
      tasks: [claudeTask({ prompt: "look at {{args.area}}" })],
      digest: { provider: "claude", model: "claude-haiku-4-5-20251001", report: "Lead with {{args.area}}." },
    });
    const plan = loadManifest(p, CFG, dir, { args: { area: "auth" } });
    equal(plan.digest.report, "Lead with auth.");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// The digest leaf dispatches through the same buildDispatch/toSpawnable path as
// any other task (scheduler.mjs) — RED before the fix: checkCommandLineLengths
// only ever measured plan.tasks, so an oversized digest.instructions block
// passed validation even though the digest leaf could never actually spawn.
test("win32 command-line check: oversized digest.instructions fails validation naming the digest", () => {
  const dir = tmp();
  try {
    const cfg = { ...CFG, claudePath: "C:\\fake\\claude.exe" };
    const p = writeManifest(dir, {
      tasks: [claudeTask()],
      digest: { provider: "claude", model: "claude-haiku-4-5-20251001", instructions: "x".repeat(32000) },
    });
    throws(
      () => loadManifest(p, cfg, dir, { io: { platform: "win32" } }),
      (e) => /digest/.test(e.message) && /command line/.test(e.message)
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("win32 command-line check: digest.instructions just under the cap passes", () => {
  const dir = tmp();
  try {
    const cfg = { ...CFG, claudePath: "C:\\fake\\claude.exe" };
    const p = writeManifest(dir, {
      tasks: [claudeTask()],
      digest: { provider: "claude", model: "claude-haiku-4-5-20251001", instructions: "x".repeat(2000) },
    });
    const plan = loadManifest(p, cfg, dir, { io: { platform: "win32" } });
    equal(plan.digest.instructions.length, 2000);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── headroom (:cloud weekly-allowance preflight) ──────────────────────────────

// Writes ~/.swarm/ollama-usage.json under a scratch SWARM_HOME so
// usageFromCache(cfg) reads a controlled reading, then restores the env var.
// `extra` merges into the cache file — lastError/lastErrorAt ride beside a
// reading exactly as a failed fetch leaves them.
function withHeadroom(dir, { weeklyPctUsed, ageMs = 0, extra = {} } = {}, fn) {
  const home = join(dir, "home");
  mkdirSync(home, { recursive: true });
  writeFileSync(join(home, "ollama-usage.json"), JSON.stringify({
    weeklyPctUsed,
    weeklyResetsAt: "2026-09-07T00:00:00Z",
    fetchedAt: Date.now() - ageMs,
    ...extra,
  }));
  const prevHome = process.env.SWARM_HOME;
  process.env.SWARM_HOME = home;
  try {
    return fn();
  } finally {
    if (prevHome === undefined) delete process.env.SWARM_HOME; else process.env.SWARM_HOME = prevHome;
  }
}

// A reading that says it was fetched NOW is the only kind that may gate —
// callers that can fetch pass `await getUsage(cfg)`; tests inject a fake.
// Shape = a raw getUsage reading after readUsage (weeklyResetsAt -> resetsAt).
const liveHeadroom = (over = {}) => ({
  state: "ok", weeklyPctUsed: 42, resetsAt: "2026-09-12T08:00:00Z",
  provenance: "live", ...over,
});

test("headroom: M1 a LIVE exhausted meter rejects a :cloud seat, naming task, model, pct, reset, recast", () => {
  const dir = tmp();
  const prevTz = process.env.TZ;
  process.env.TZ = "Europe/London";
  try {
    const p = writeManifest(dir, { tasks: [{ id: "find-diag", prompt: "p", provider: "ollama", model: "glm-5.3:cloud" }] });
    const cfg = { ...CFG, provider: { allowedRoots: [dir], cloud: { ollama: { enabled: true } } } };
    const errs = errorsOf(() => loadManifest(p, cfg, dir, {
      headroom: liveHeadroom({ state: "exhausted", weeklyPctUsed: 100, resetsAt: "2026-09-07T00:00:00Z" }),
    }));
    ok(errs.some((e) =>
      e.includes("find-diag") && e.includes("glm-5.3:cloud") && e.includes("100")
      && e.includes("Mon 7 Sep, 01:00") && /recast/i.test(e)
    ), errs.join("|"));
  } finally {
    if (prevTz === undefined) delete process.env.TZ; else process.env.TZ = prevTz;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("headroom: M2 false-positive guard — Claude-only manifests are untouched by an exhausted meter", () => {
  const dir = tmp();
  try {
    const p = writeManifest(dir, { tasks: [claudeTask({ provider: "claude", model: "claude-sonnet-5" }), claudeTask({ id: "b", provider: "claude", model: "claude-haiku-4-5-20251001" })] });
    const cfg = { ...CFG, provider: { allowedRoots: [], cloud: { ollama: { enabled: true } } } };
    withHeadroom(dir, { weeklyPctUsed: 100 }, () => {
      const plan = loadManifest(p, cfg, dir);
      equal(plan.tasks.length, 2);
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("headroom: M3 false-positive guard — a LIVE healthy meter passes with no new output", () => {
  const dir = tmp();
  try {
    const p = writeManifest(dir, { tasks: [{ id: "find-diag", prompt: "p", provider: "ollama", model: "glm-5.3:cloud" }] });
    const cfg = { ...CFG, provider: { allowedRoots: [dir], cloud: { ollama: { enabled: true } } } };
    const plan = loadManifest(p, cfg, dir, { headroom: liveHeadroom({ weeklyPctUsed: 42 }) });
    equal(plan.tasks[0].model, "glm-5.3:cloud");
    equal(plan.warnings, undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("headroom: M4 no configured cookie (unknown) does not fail a manifest", () => {
  const dir = tmp();
  try {
    const p = writeManifest(dir, { tasks: [{ id: "find-diag", prompt: "p", provider: "ollama", model: "glm-5.3:cloud" }] });
    // cloud.ollama.enabled left off entirely -> usageFromCache is "unknown" with no cache file needed.
    const cfg = { ...CFG, provider: { allowedRoots: [dir] } };
    const plan = loadManifest(p, cfg, dir);
    equal(plan.tasks[0].model, "glm-5.3:cloud");
    equal(plan.warnings, undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// The default headroom (cache-only usageFromCache) carries provenance cached +
// the cache's recorded lastError — the warning carries the banner text, which
// is where `/!\ Cookie Expired` reaches validate output.
test("headroom: M5 a cached figure warns with its banner (last-seen stamp, the refresh command), does not fail", () => {
  const dir = tmp();
  try {
    const p = writeManifest(dir, { tasks: [{ id: "find-diag", prompt: "p", provider: "ollama", model: "glm-5.3:cloud" }] });
    const cfg = { ...CFG, provider: { allowedRoots: [dir], cloud: { ollama: { enabled: true } } } };
    withHeadroom(dir, { weeklyPctUsed: 42, extra: { lastError: "expired-cookie", lastErrorAt: Date.now() - 86_400_000 } }, () => {
      const plan = loadManifest(p, cfg, dir);
      equal(plan.tasks[0].model, "glm-5.3:cloud");
      const w = plan.warnings?.find((w) => w.includes("find-diag"));
      ok(w, JSON.stringify(plan.warnings));
      ok(w.includes("/!\\ Cookie Expired"), w);
      ok(/last seen: \d{4}-\d{2}-\d{2}T/.test(w), "absolute UTC stamp, not an age");
      ok(w.includes("swarm ollama-usage"), w);
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("headroom: M7 governance is reported before the headroom rejection", () => {
  const dir = tmp();
  try {
    const p = writeManifest(dir, { tasks: [{ id: "find-diag", prompt: "p", provider: "ollama", model: "glm-5.3:cloud" }] });
    // allowedRoots empty -> cwd is outside every allowed root
    const cfg = { ...CFG, provider: { allowedRoots: [], cloud: { ollama: { enabled: true } } } };
    const errs = errorsOf(() => loadManifest(p, cfg, dir, {
      headroom: liveHeadroom({ state: "exhausted", weeklyPctUsed: 100, weeklyResetsAt: "2026-09-07T00:00:00Z" }),
    }));
    const govIdx = errs.findIndex((e) => e.includes("data governance"));
    const headroomIdx = errs.findIndex((e) => e.includes("weekly allowance is exhausted"));
    ok(govIdx !== -1 && headroomIdx !== -1, errs.join("|"));
    ok(govIdx < headroomIdx, `expected governance before headroom, got: ${errs.join("|")}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// Test 5 — the two 100% verdicts. A live one fails the run; a cached one (the
// cookie expired and the meter says 100 from 33h ago) succeeds, because the
// window may have reset since — the warning carries the banner instead.
test("headroom: T5 a live 100% fails; a cached 100% succeeds with the banner in its warning", async () => {
  const dir = tmp();
  try {
    const p = writeManifest(dir, { tasks: [{ id: "find-diag", prompt: "p", provider: "ollama", model: "glm-5.3:cloud" }] });
    const cfg = { ...CFG, provider: { allowedRoots: [dir], cloud: { ollama: { enabled: true } } } };

    const liveErrs = errorsOf(() => loadManifest(p, cfg, dir, {
      headroom: liveHeadroom({ state: "exhausted", weeklyPctUsed: 100, resetsAt: "R" }),
    }));
    ok(liveErrs.some((e) => e.includes("weekly allowance is exhausted")), liveErrs.join("|"));

    // Build the cached-100% reading the way production does: getUsage over a
    // redirecting fetch (expired cookie) and a 100% cache file.
    resetUsageMemo();
    const home = join(dir, "home2");
    mkdirSync(home, { recursive: true });
    writeFileSync(join(home, "ollama-usage.json"), JSON.stringify({
      weeklyPctUsed: 100, weeklyResetsAt: "2026-09-07T00:00:00Z", fetchedAt: Date.now() - 33 * 3_600_000,
    }));
    saveCookie(join(home, "ollama-cookie.json"), "expired");
    const redirect = async () => ({ status: 303, headers: { get: () => "https://ollama.com/signin" }, text: async () => "" });
    const headroom = await getUsage(cfg, { env: { SWARM_HOME: home }, _fetch: redirect });
    equal(headroom.provenance, "cached");
    equal(headroom.state, "exhausted");

    const plan = loadManifest(p, cfg, dir, { headroom });
    ok(plan.warnings?.some((w) => w.includes("find-diag") && w.includes("/!\\ Cookie Expired")), JSON.stringify(plan.warnings));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// Test 6 — one fetch per process across seats and stages: five :cloud seats
// read the meter once, and the second stage (a run re-reading after validate)
// reuses the memo rather than refetching.
test("headroom: T6 five :cloud seats fetch the meter exactly once — the memo carries validate into run", async () => {
  const dir = tmp();
  try {
    const p = writeManifest(dir, {
      tasks: ["a", "b", "c", "d", "e"].map((id) => ({ id, prompt: "p", provider: "ollama", model: "glm-5.3:cloud", cwd: dir })),
    });
    const cfg = { ...CFG, provider: { allowedRoots: [dir], cloud: { ollama: { enabled: true } } } };
    let fetches = 0;
    const counting = async () => { fetches++; return { status: 200, headers: { get: () => null }, text: async () => readFileSync(join(import.meta.dirname, "fixtures", "ollama-settings.html"), "utf8") }; };
    resetUsageMemo();
    saveCookie(join(dir, "ollama-cookie.json"), "tok");
    const headroom = await getUsage(cfg, { env: { SWARM_HOME: dir }, _fetch: counting });
    const validated = loadManifest(p, cfg, dir, { headroom });
    equal(validated.tasks.length, 5);
    const rerun = loadManifest(p, cfg, dir, { headroom: await getUsage(cfg, { env: { SWARM_HOME: dir }, _fetch: counting }) });
    equal(rerun.tasks.length, 5);
    equal(fetches, 1, "two stages, five seats, ONE fetch — the memo is the seam");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── how a leaf's tree is derived ──────────────────────────────────────────────

test("the write tools alone decide the tree: every writer gets one, the reader none", () => {
  const dir = tmp();
  try {
    const p = writeManifest(dir, {
      resultsDir: "res",
      tasks: [
        claudeTask({ id: "gen", allowedTools: "Read,Write" }),
        claudeTask({ id: "bash", allowedTools: "Bash" }),
        claudeTask({ id: "impl", allowedTools: "Read,Edit,Bash" }),
        claudeTask({ id: "ro", allowedTools: "Read,Grep" }),
      ],
    });
    const plan = loadManifest(p, CFG, dir);
    const byId = Object.fromEntries(plan.tasks.map((t) => [t.id, t]));
    for (const id of ["gen", "bash", "impl"]) {
      equal(byId[id].worktreeName, id, `${id} owns a tree named for itself`);
      ok(byId[id].branchScope, `${id}'s branch is run-scoped`);
      equal(byId[id].cwd, dir, "the declared cwd is untouched at normalise time");
    }
    equal(byId.ro.worktreeName, undefined);
    equal(byId.ro.branchScope, undefined);
    equal(byId.ro.cwd, dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── resultsDir default ────────────────────────────────────────────────────────

test("default resultsDir is <home>/runs/<encoded-repo-toplevel>/<stem>-1, reusing highest existing n for resume", () => {
  const dir = tmp();
  const prevHome = process.env.SWARM_HOME;
  process.env.SWARM_HOME = join(dir, "home");
  const base = join(dir, "home", "runs", dir.replace(/[\\/:]/g, "-"));
  try {
    const p = writeManifest(dir, { tasks: [claudeTask()] }, "sweep.json");
    const plan1 = loadManifest(p, CFG, dir);
    equal(plan1.resultsDir, join(base, "sweep-1"));

    mkdirSync(join(base, "sweep-1"), { recursive: true });
    mkdirSync(join(base, "sweep-3"), { recursive: true });
    const plan2 = loadManifest(p, CFG, dir);
    equal(plan2.resultsDir, join(base, "sweep-3"));
  } finally {
    if (prevHome === undefined) delete process.env.SWARM_HOME; else process.env.SWARM_HOME = prevHome;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("model-authored manifests: markdown fences around the JSON are tolerated", () => {
  const dir = tmp();
  try {
    const p = join(dir, "fenced.json");
    writeFileSync(p, "```json\n" + JSON.stringify({ tasks: [claudeTask()] }) + "\n```\n");
    const plan = loadManifest(p, CFG, dir);
    equal(plan.tasks.length, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("unreadable manifest throws ValidationError", () => {
  const dir = tmp();
  try {
    throws(() => loadManifest(join(dir, "missing.json"), CFG, dir), ValidationError);
    const p = join(dir, "broken.json");
    writeFileSync(p, "{ nope");
    throws(() => loadManifest(p, CFG, dir), ValidationError);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── deterministic steps: compute / when / forEach ─────────────────────────────

test("compute: valid task normalizes agentless with the expression carried", () => {
  const dir = tmp();
  try {
    const p = writeManifest(dir, {
      tasks: [
        claudeTask({ id: "scan" }),
        { id: "dedupe", after: ["scan"], compute: "unique_by(deps['scan'].sites, 'file')" },
      ],
    });
    // allowedRoots is empty — a compute step spawns nothing, so no governance
    const plan = loadManifest(p, CFG, dir);
    const dd = plan.tasks.find((t) => t.id === "dedupe");
    equal(dd.compute, "unique_by(deps['scan'].sites, 'file')");
    equal(dd.model, "compute");
    equal(hasWriteTools(dd.allowedTools), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("compute: agentless — model/prompt rejected, forEach mutually exclusive, string required", () => {
  const dir = tmp();
  try {
    const p = writeManifest(dir, {
      tasks: [
        claudeTask({ id: "scan" }),
        { id: "c1", after: ["scan"], compute: "count(deps.scan.xs)", provider: "claude", model: "claude-haiku-4-5-20251001", prompt: "p" },
        { id: "c2", after: ["scan"], compute: "count(deps.scan.xs)", forEach: { from: "scan", maxItems: 2 } },
        { id: "c3", after: ["scan"], compute: 42 },
      ],
    });
    const errs = errorsOf(() => loadManifest(p, CFG, dir));
    ok(errs.some((e) => e.includes("c1") && e.includes("agentless")), errs.join("|"));
    ok(errs.some((e) => e.includes("c2") && e.includes("forEach") && e.includes("compute")), errs.join("|"));
    ok(errs.some((e) => e.includes("c3") && e.includes("string")), errs.join("|"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("compute: expression errors embed the teaching message with caret", () => {
  const dir = tmp();
  try {
    const p = writeManifest(dir, {
      tasks: [claudeTask({ id: "scan" }), { id: "dedupe", after: ["scan"], compute: "nope(deps.scan)" }],
    });
    const errs = errorsOf(() => loadManifest(p, CFG, dir));
    const hit = errs.find((e) => e.includes("unknown function 'nope'"));
    ok(hit, errs.join("|"));
    ok(hit.includes("dedupe"), hit);
    ok(hit.includes("^"), hit);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("compute: deps refs must be declared deps; dynamic access and 'value' rejected", () => {
  const dir = tmp();
  try {
    const p = writeManifest(dir, {
      tasks: [
        claudeTask({ id: "scan" }),
        { id: "g", after: ["scan"], compute: "unique_by(deps['ghost'].sites, 'f')" },
        { id: "d", after: ["scan"], compute: "length(deps) > 0" },
        { id: "v", after: ["scan"], compute: "length(value) > 0" },
      ],
    });
    const errs = errorsOf(() => loadManifest(p, CFG, dir));
    ok(errs.some((e) => e.includes("'ghost'") && e.includes("after")), errs.join("|"));
    ok(errs.some((e) => e.includes("task 'd'") && e.includes("literal")), errs.join("|"));
    ok(errs.some((e) => e.includes("task 'v'") && e.includes("'value'") && e.includes("when")), errs.join("|"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("when: valid gate carried through; composes with forEach", () => {
  const dir = tmp();
  try {
    const p = writeManifest(dir, {
      tasks: [
        claudeTask({ id: "scan" }),
        claudeTask({ id: "gate", after: ["scan"], when: { from: "scan", expr: "length(value) > 2" } }),
        claudeTask({
          id: "fan", after: ["scan"],
          when: { from: "scan", expr: "length(value) > 0" },
          forEach: { from: "scan", maxItems: 5 },
          prompt: "handle {{item}}",
        }),
      ],
    });
    const plan = loadManifest(p, CFG, dir);
    deepEqual(plan.tasks.find((t) => t.id === "gate").when, { from: "scan", expr: "length(value) > 2" });
    const fan = plan.tasks.find((t) => t.id === "fan");
    deepEqual(fan.when, { from: "scan", expr: "length(value) > 0" });
    deepEqual(fan.forEach, { from: "scan", path: "", maxItems: 5 });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("when: shape errors teach — from/expr required, from in after, value-only scope, no stray keys", () => {
  const dir = tmp();
  try {
    const p = writeManifest(dir, {
      tasks: [
        claudeTask({ id: "scan" }),
        claudeTask({ id: "other" }),
        claudeTask({ id: "w1", after: ["scan"], when: { expr: "true" } }),
        claudeTask({ id: "w2", after: ["scan"], when: { from: "scan" } }),
        claudeTask({ id: "w3", after: ["scan"], when: { from: "other", expr: "true" } }),
        claudeTask({ id: "w4", after: ["scan"], when: { from: "scan", expr: "1 +" } }),
        claudeTask({ id: "w5", after: ["scan"], when: { from: "scan", expr: "deps.scan.n > 0" } }),
        claudeTask({ id: "w6", after: ["scan"], when: { from: "scan", expr: "true", if: "x" } }),
      ],
    });
    const errs = errorsOf(() => loadManifest(p, CFG, dir));
    ok(errs.some((e) => e.includes("w1") && e.includes("when.from is required")), errs.join("|"));
    ok(errs.some((e) => e.includes("w2") && e.includes("when.expr is required")), errs.join("|"));
    ok(errs.some((e) => e.includes("w3") && e.includes("after")), errs.join("|"));
    ok(errs.some((e) => e.includes("w4") && e.includes("arithmetic")), errs.join("|"));
    ok(errs.some((e) => e.includes("w5") && e.includes("'value'") && e.includes("compute")), errs.join("|"));
    ok(errs.some((e) => e.includes("w6") && e.includes("unknown key 'if'")), errs.join("|"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("forEach: valid block carried; path defaults to empty; template placeholders allowed", () => {
  const dir = tmp();
  try {
    const p = writeManifest(dir, {
      tasks: [
        claudeTask({ id: "scan" }),
        { id: "dedupe", after: ["scan"], compute: "unique_by(deps['scan'].sites, 'file')" },
        claudeTask({
          id: "fix", after: ["dedupe"],
          forEach: { from: "dedupe", path: "sites", maxItems: 30 },
          prompt: "Fix {{item.file}} (clone {{index}}) using {{result:dedupe}}",
        }),
      ],
    });
    const plan = loadManifest(p, CFG, dir);
    deepEqual(plan.tasks.find((t) => t.id === "fix").forEach, { from: "dedupe", path: "sites", maxItems: 30 });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("forEach: maxItems is the approval cap — required, positive integer", () => {
  const dir = tmp();
  try {
    const p = writeManifest(dir, {
      tasks: [
        claudeTask({ id: "scan" }),
        claudeTask({ id: "f1", after: ["scan"], forEach: { from: "scan" } }),
        claudeTask({ id: "f2", after: ["scan"], forEach: { from: "scan", maxItems: 0 } }),
        claudeTask({ id: "f3", after: ["scan"], forEach: { from: "scan", maxItems: "30" } }),
      ],
    });
    const errs = errorsOf(() => loadManifest(p, CFG, dir));
    const req = errs.find((e) => e.includes("f1") && e.includes("maxItems is required"));
    ok(req, errs.join("|"));
    ok(/approval/.test(req), req);
    ok(errs.some((e) => e.includes("f2") && e.includes("positive integer")), errs.join("|"));
    ok(errs.some((e) => e.includes("f3") && e.includes("positive integer")), errs.join("|"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("forEach: from required and declared in after; no stray keys", () => {
  const dir = tmp();
  try {
    const p = writeManifest(dir, {
      tasks: [
        claudeTask({ id: "scan" }),
        claudeTask({ id: "other" }),
        claudeTask({ id: "f1", after: ["scan"], forEach: { maxItems: 3 } }),
        claudeTask({ id: "f2", after: ["scan"], forEach: { from: "other", maxItems: 3 } }),
        claudeTask({ id: "f3", after: ["scan"], forEach: { from: "scan", maxItems: 3, filter: "x" } }),
      ],
    });
    const errs = errorsOf(() => loadManifest(p, CFG, dir));
    ok(errs.some((e) => e.includes("f1") && e.includes("forEach.from is required")), errs.join("|"));
    ok(errs.some((e) => e.includes("f2") && e.includes("after")), errs.join("|"));
    ok(errs.some((e) => e.includes("f3") && e.includes("unknown key 'filter'")), errs.join("|"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("{{item}}/{{index}} placeholders demand a forEach block", () => {
  const dir = tmp();
  try {
    const p = writeManifest(dir, {
      tasks: [
        claudeTask({ id: "a", prompt: "do {{item.file}}" }),
        claudeTask({ id: "b", prompt: "n {{index}}" }),
      ],
    });
    const errs = errorsOf(() => loadManifest(p, CFG, dir));
    ok(errs.some((e) => e.includes("'a'") && e.includes("forEach")), errs.join("|"));
    ok(errs.some((e) => e.includes("'b'") && e.includes("forEach")), errs.join("|"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("[n]-suffixed ids are reserved for forEach clones", () => {
  const dir = tmp();
  try {
    const p = writeManifest(dir, { tasks: [claudeTask({ id: "fix[0]" })] });
    const errs = errorsOf(() => loadManifest(p, CFG, dir));
    ok(errs.some((e) => e.includes("reserved") && e.includes("clone")), errs.join("|"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("unknown task keys rejected with the known-key list (catches the foreach typo)", () => {
  const dir = tmp();
  try {
    const p = writeManifest(dir, {
      tasks: [claudeTask({ foreach: { from: "x", maxItems: 1 } })],
    });
    const errs = errorsOf(() => loadManifest(p, CFG, dir));
    const hit = errs.find((e) => e.includes("unknown key 'foreach'"));
    ok(hit, errs.join("|"));
    ok(hit.includes("forEach"), hit); // the known-key list shows the casing fix
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── helpers ───────────────────────────────────────────────────────────────────

test("isUnderRoot: boundary-aware, separator-tolerant", () => {
  const root = join(tmpdir(), "rootdir");
  equal(isUnderRoot(join(root, "sub"), root), true);
  equal(isUnderRoot(root, root), true);
  equal(isUnderRoot(root + "extra", root), false);
  equal(isUnderRoot(root.replaceAll(sep, "/") + "/sub", root), true);
});

// io.repoToplevel stub: pretends `cwd` sits inside a repo whose root is `top`,
// or returns null (git failed) so guardFor falls back to basename(cwd).
function ioWithToplevel(top) {
  return { repoToplevel: () => top };
}
const ioNoGit = { repoToplevel: () => null };

test("guardFor: no projects -> undefined; matching repo name -> its command; unknown name -> undefined; Windows case-insensitive", () => {
  const repo = join(tmpdir(), "myrepo");
  const nested = join(repo, "sub");
  const elsewhere = join(tmpdir(), "elsewhere");
  equal(guardFor(repo, {}, ioNoGit), undefined);
  equal(guardFor(repo, { projects: [] }, ioNoGit), undefined);
  equal(guardFor(elsewhere, { projects: [{ name: "myrepo", hooks: { preToolUse: "cmd-a" } }] }, ioNoGit), undefined);
  // io.repoToplevel resolves the leaf's repo root; the project name matches its basename
  deepEqual(
    guardFor(nested, { projects: [{ name: "myrepo", hooks: { preToolUse: "cmd-a" } }] }, ioWithToplevel(repo)),
    { name: "myrepo", command: "cmd-a" },
  );
  // git fails -> falls back to the basename of originalCwd itself
  deepEqual(
    guardFor(repo, { projects: [{ name: "myrepo", hooks: { preToolUse: "cmd-a" } }] }, ioNoGit),
    { name: "myrepo", command: "cmd-a" },
  );
  // a project with no preToolUse yields no guard
  equal(
    guardFor(repo, { projects: [{ name: "myrepo", hooks: {} }] }, ioNoGit),
    undefined,
  );
  if (process.platform === "win32") {
    deepEqual(
      guardFor(join(tmpdir(), "MYREPO"), { projects: [{ name: "myrepo", hooks: { preToolUse: "cmd-a" } }] }, ioNoGit),
      { name: "myrepo", command: "cmd-a" },
    );
  }
});

test("hasWriteTools detects each write tool, case-insensitive", () => {
  equal(hasWriteTools("Read,Grep"), false);
  equal(hasWriteTools("Read,Edit"), true);
  equal(hasWriteTools("write"), true);
  equal(hasWriteTools("Bash"), true);
  equal(hasWriteTools("NotebookEdit"), true);
  equal(hasWriteTools(undefined), false);
});

// ── returns (schema-validated output) ─────────────────────────────────────────

test("returns: accepted on a leaf and a forEach task, carried through normalization", () => {
  const dir = tmp();
  try {
    const schema = { type: "object", required: ["sites"], properties: { sites: { type: "array" } } };
    const p = writeManifest(dir, {
      tasks: [
        claudeTask({ returns: schema }),
        claudeTask({
          id: "per", prompt: "check {{item}}", after: ["a"],
          forEach: { from: "a", path: "sites", maxItems: 3 },
          returns: { type: "string" },
        }),
      ],
    });
    const plan = loadManifest(p, CFG, dir);
    deepEqual(plan.tasks[0].returns, schema);
    deepEqual(plan.tasks[1].returns, { type: "string" });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("returns on a compute task is rejected — point it at the producing leaf", () => {
  const dir = tmp();
  try {
    const p = writeManifest(dir, {
      tasks: [
        claudeTask(),
        { id: "dedupe", compute: "unique_by(deps['a'], 'file')", after: ["a"], returns: { type: "array" } },
      ],
    });
    const errs = errorsOf(() => loadManifest(p, CFG, dir));
    ok(errs.some((e) => e.includes("task 'dedupe'") && e.includes("engine-deterministic") && e.includes("leaf")), errs.join("\n"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("returns must be an object — teaching error carries an inline example", () => {
  const dir = tmp();
  try {
    const p = writeManifest(dir, { tasks: [claudeTask({ returns: "json" })] });
    const errs = errorsOf(() => loadManifest(p, CFG, dir));
    ok(errs.some((e) => e.includes("task 'a'") && e.includes("returns must be an object") && e.includes('"type"')), errs.join("\n"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("returns: schema shape errors surface per problem with the task label", () => {
  const dir = tmp();
  try {
    const p = writeManifest(dir, {
      tasks: [claudeTask({ returns: { type: "list", additionalProperties: false } })],
    });
    const errs = errorsOf(() => loadManifest(p, CFG, dir));
    ok(errs.some((e) => e.includes("task 'a'") && e.includes("type 'list' is not supported")), errs.join("\n"));
    ok(errs.some((e) => e.includes("task 'a'") && e.includes("unknown keyword 'additionalProperties'")), errs.join("\n"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the unknown-key message now lists returns (typo teaching)", () => {
  const dir = tmp();
  try {
    const p = writeManifest(dir, { tasks: [claudeTask({ return: { type: "array" } })] });
    const errs = errorsOf(() => loadManifest(p, CFG, dir));
    const hit = errs.find((e) => e.includes("unknown key 'return'"));
    ok(hit, errs.join("|"));
    ok(hit.includes("returns"), hit);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── child manifests (bounded composition) ─────────────────────────────────────

const CHILD = {
  tasks: [
    { id: "scan", prompt: "look at {{item}}", provider: "claude", model: "claude-haiku-4-5-20251001" },
    { id: "sum", prompt: "compress {{result:scan}}", provider: "claude", model: "claude-haiku-4-5-20251001", after: ["scan"] },
  ],
};

test("manifest task: child loads, validates, and lands normalized on childPlan", () => {
  const dir = tmp();
  try {
    writeFileSync(join(dir, "child.json"), JSON.stringify(CHILD));
    const p = writeManifest(dir, {
      tasks: [
        claudeTask({ id: "seed" }),
        { id: "audit", manifest: "child.json", after: ["seed"], forEach: { from: "seed", path: "", maxItems: 3 } },
      ],
    });
    const plan = loadManifest(p, CFG, dir);
    const node = plan.tasks.find((t) => t.id === "audit");
    equal(node.model, "manifest");
    equal(node.childPlan.tasks.length, 2);
    equal(node.childPlan.tasks[0].id, "scan");
    equal(node.childPlan.tasks[0].allowedTools, DEFAULT_TOOLS);
    deepEqual(node.childPlan.tasks[1].after, ["scan"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("manifest task: agentless container — leaf keys on the node are rejected", () => {
  const dir = tmp();
  try {
    writeFileSync(join(dir, "child.json"), JSON.stringify(CHILD));
    const p = writeManifest(dir, {
      tasks: [{
        id: "audit", manifest: "child.json", provider: "claude", model: "claude-haiku-4-5-20251001", prompt: "x",
        returns: { type: "object" }, after: [],
      }],
    });
    const errs = errorsOf(() => loadManifest(p, CFG, dir));
    for (const key of ["model", "prompt", "returns"]) {
      ok(errs.some((e) => e.includes("task 'audit'") && e.includes(key) && e.includes("agentless container")), `${key}:\n${errs.join("\n")}`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("child manifests may not set resultsDir/concurrency/digest — the parent owns the run", () => {
  const dir = tmp();
  try {
    writeFileSync(join(dir, "child.json"), JSON.stringify({
      ...CHILD, resultsDir: "out", concurrency: 2, digest: { provider: "claude", model: "claude-haiku-4-5-20251001" },
    }));
    const p = writeManifest(dir, { tasks: [{ id: "audit", manifest: "child.json" }] });
    const errs = errorsOf(() => loadManifest(p, CFG, dir));
    for (const key of ["resultsDir", "concurrency", "digest"]) {
      ok(errs.some((e) => e.includes(key) && e.includes("parent owns the run")), `${key}:\n${errs.join("\n")}`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("one nesting level: a manifest task inside a child errors naming both files", () => {
  const dir = tmp();
  try {
    writeFileSync(join(dir, "grandchild.json"), JSON.stringify({ tasks: [claudeTask()] }));
    writeFileSync(join(dir, "child.json"), JSON.stringify({
      tasks: [{ id: "deep", manifest: "grandchild.json" }],
    }));
    const p = writeManifest(dir, { tasks: [{ id: "audit", manifest: "child.json" }] });
    const errs = errorsOf(() => loadManifest(p, CFG, dir));
    ok(errs.some((e) => e.includes("one nesting level") && e.includes("child.json")), errs.join("\n"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("child task errors surface in the parent's validate output, prefixed", () => {
  const dir = tmp();
  try {
    writeFileSync(join(dir, "child.json"), JSON.stringify({
      tasks: [{ id: "scan", provider: "claude", model: "claude-haiku-4-5-20251001" }], // missing prompt
    }));
    const p = writeManifest(dir, { tasks: [{ id: "audit", manifest: "child.json" }] });
    const errs = errorsOf(() => loadManifest(p, CFG, dir));
    ok(errs.some((e) => e.includes("task 'audit' -> child") && e.includes("scan") && e.includes("prompt is required")), errs.join("\n"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("{{item}} in child prompts requires forEach on the parent node", () => {
  const dir = tmp();
  try {
    writeFileSync(join(dir, "child.json"), JSON.stringify(CHILD)); // scan uses {{item}}
    const p = writeManifest(dir, { tasks: [{ id: "audit", manifest: "child.json" }] });
    const errs = errorsOf(() => loadManifest(p, CFG, dir));
    ok(errs.some((e) => e.includes("{{item}}") && e.includes("forEach")), errs.join("\n"));

    const p2 = writeManifest(dir, {
      tasks: [
        claudeTask({ id: "seed" }),
        { id: "audit", manifest: "child.json", after: ["seed"], forEach: { from: "seed", path: "", maxItems: 2 } },
      ],
    }, "ok.json");
    const plan = loadManifest(p2, CFG, dir);
    ok(plan.tasks.find((t) => t.id === "audit").childPlan);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── W1: named manifests + args ────────────────────────────────────────────────

import { notEqual } from "node:assert/strict";
import { basename } from "node:path";

test("args: substitute into prompts and digest instructions; substituteItems value rendering", () => {
  const dir = tmp();
  try {
    const p = writeManifest(dir, {
      resultsDir: "out",
      tasks: [claudeTask({ prompt: "review {{args.base}} count {{args.n}} cfg {{args.cfg}}" })],
      digest: { provider: "claude", model: "claude-haiku-4-5-20251001", instructions: "focus on {{args.base}}" },
    });
    const plan = loadManifest(p, CFG, dir, { args: { base: "master", n: 7, cfg: { deep: true } } });
    equal(plan.tasks[0].prompt, 'review master count 7 cfg {"deep":true}');
    equal(plan.digest.instructions, "focus on master");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("args: no placeholders + no args = today's plan, byte-identical (regression pin)", () => {
  const dir = tmp();
  try {
    const p = writeManifest(dir, { resultsDir: "out", tasks: [claudeTask()] });
    deepEqual(loadManifest(p, CFG, dir, {}), loadManifest(p, CFG, dir));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("args: unknown placeholder fails validation naming placeholder + supplied keys — never empty-substitutes", () => {
  const dir = tmp();
  try {
    const p = writeManifest(dir, { resultsDir: "out", tasks: [claudeTask({ prompt: "use {{args.missing}}" })] });
    const errs = errorsOf(() => loadManifest(p, CFG, dir, { args: { base: "x" } }));
    ok(errs.some((e) => e.includes("{{args.missing}}") && e.includes("base")), errs.join("|"));
    // placeholder with no --args at all is the same failure, not a crash
    const errs2 = errorsOf(() => loadManifest(p, CFG, dir));
    ok(errs2.some((e) => e.includes("{{args.missing}}")), errs2.join("|"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("args: supplied key never referenced fails validation (typo protection)", () => {
  const dir = tmp();
  try {
    const p = writeManifest(dir, { resultsDir: "out", tasks: [claudeTask({ prompt: "use {{args.base}}" })] });
    const errs = errorsOf(() => loadManifest(p, CFG, dir, { args: { base: "x", extra: "y" } }));
    ok(errs.some((e) => e.includes("'extra'")), errs.join("|"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("args: smuggled {{result:}} in an arg value hits template validation and dies", () => {
  const dir = tmp();
  try {
    const p = writeManifest(dir, { resultsDir: "out", tasks: [claudeTask({ prompt: "do {{args.payload}}" })] });
    const errs = errorsOf(() => loadManifest(p, CFG, dir, { args: { payload: "{{result:ghost}}" } }));
    ok(errs.some((e) => e.includes("'ghost'")), errs.join("|"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("args: child manifest prompts participate; unused check spans parent+children; child errors labelled", () => {
  const dir = tmp();
  try {
    writeManifest(dir, { tasks: [{ id: "c1", prompt: "scan {{args.base}}", provider: "claude", model: "claude-haiku-4-5-20251001" }] }, "child.json");
    const p = writeManifest(dir, { resultsDir: "out", tasks: [{ id: "outer", manifest: "child.json" }] });
    // key used only inside the child -> substituted there, no unused error
    const plan = loadManifest(p, CFG, dir, { args: { base: "master" } });
    equal(plan.tasks[0].childPlan.tasks[0].prompt, "scan master");

    // unknown key inside the child -> error carries the child label
    writeManifest(dir, { tasks: [{ id: "c1", prompt: "scan {{args.nope}}", provider: "claude", model: "claude-haiku-4-5-20251001" }] }, "child2.json");
    const p2 = writeManifest(dir, { resultsDir: "out", tasks: [{ id: "outer", manifest: "child2.json" }] }, "plan2.json");
    const errs = errorsOf(() => loadManifest(p2, CFG, dir, { args: {} }));
    ok(errs.some((e) => e.includes("child") && e.includes("{{args.nope}}")), errs.join("|"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("registry-sourced parent resolves child manifest paths against the parent's dir, not cwd", () => {
  const dirA = tmp(); // where the saved manifest + its child live
  const dirB = tmp(); // the invoking cwd
  try {
    writeManifest(dirA, { tasks: [{ id: "c1", prompt: "scan", provider: "claude", model: "claude-haiku-4-5-20251001" }] }, "child.json");
    const parent = writeManifest(dirA, { resultsDir: "out", tasks: [{ id: "outer", manifest: "child.json" }] }, "parent.json");
    // registry-sourced: child found next to the parent
    const plan = loadManifest(parent, CFG, dirB, { fromRegistry: true });
    equal(plan.tasks[0].childPlan.tasks[0].prompt, "scan");
    // plain path invocation keeps today's cwd resolution -> child not found from dirB
    const errs = errorsOf(() => loadManifest(parent, CFG, dirB));
    ok(errs.some((e) => e.includes("cannot read child manifest")), errs.join("|"));
  } finally {
    rmSync(dirA, { recursive: true, force: true });
    rmSync(dirB, { recursive: true, force: true });
  }
});

test("args fingerprint keys the default results dir; key order irrelevant; no args = today's stem", () => {
  const dir = tmp();
  const home = tmp();
  const saved = process.env.SWARM_HOME;
  process.env.SWARM_HOME = home;
  try {
    const p = writeManifest(dir, { tasks: [claudeTask({ prompt: "{{args.a}} {{args.b}}" })] });
    const stemOf = (plan) => basename(plan.resultsDir);
    const a = loadManifest(p, CFG, dir, { args: { b: "x", a: 1 } });
    const b = loadManifest(p, CFG, dir, { args: { a: 1, b: "x" } });
    const c = loadManifest(p, CFG, dir, { args: { a: 2, b: "x" } });
    ok(/^plan\.[0-9a-f]{8}-1$/.test(stemOf(a)), stemOf(a));
    equal(stemOf(a), stemOf(b));
    notEqual(stemOf(a), stemOf(c));
    const plain = writeManifest(dir, { tasks: [claudeTask()] }, "plain.json");
    ok(/^plain-1$/.test(basename(loadManifest(plain, CFG, dir).resultsDir)));
  } finally {
    if (saved === undefined) delete process.env.SWARM_HOME;
    else process.env.SWARM_HOME = saved;
    rmSync(dir, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});

test("workspace normalizes to a shared tree name; silence means the task's own id", () => {
  const dir = tmp();
  try {
    const p = writeManifest(dir, { tasks: [
      writerTask({ id: "p1", workspace: "feat" }),
      writerTask({ id: "p2", after: ["p1"], workspace: "feat" }),
      writerTask({ id: "solo" }),
    ] });
    const plan = loadManifest(p, CFG, dir);
    const byId = Object.fromEntries(plan.tasks.map((t) => [t.id, t]));
    equal(byId.p1.worktreeName, "feat");
    equal(byId.p2.worktreeName, "feat");
    equal(byId.solo.worktreeName, "solo", "no workspace means the task's own id");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("workspace rejects an empty or non-filename-safe name", () => {
  const dir = tmp();
  try {
    const bad = writeManifest(dir, { tasks: [writerTask({ workspace: "" })] }, "b1.json");
    ok(errorsOf(() => loadManifest(bad, CFG, dir)).some((e) => /non-empty string/i.test(e)));

    const unsafe = writeManifest(dir, { tasks: [writerTask({ workspace: "a/b" })] }, "b2.json");
    ok(errorsOf(() => loadManifest(unsafe, CFG, dir)).some((e) => /filename-safe/i.test(e)));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("a shared workspace is still run-scoped: naming a tree is not opting out of scoping", () => {
  // RED: skip branchScope when workspace is written, and a kept tree from the last run
  // of this manifest blocks the next at `worktree add` — the #297 defect by the other
  // spelling. Only an explicit `branch` opts out.
  const dir = tmp();
  try {
    const p = writeManifest(dir, { tasks: [writerTask({ id: "p1", workspace: "feat" })] });
    const t = loadManifest(p, CFG, dir).tasks[0];
    ok(t.branchScope, "a derived branch is always run-scoped");
    equal(t.worktreeName, "feat");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("tasks sharing a workspace must be totally ordered", () => {
  const dir = tmp();
  try {
    const p = writeManifest(dir, { tasks: [
      writerTask({ id: "p1", workspace: "feat" }),
      writerTask({ id: "p2", after: ["p1"], workspace: "feat" }),
      writerTask({ id: "p3", after: ["p1"], workspace: "feat" }),
    ] });
    const msg = errorsOf(() => loadManifest(p, CFG, dir)).join("\n");
    ok(/'p2'.*'p3'|'p3'.*'p2'/.test(msg), `expected the unordered pair named: ${msg}`);
    ok(/after/.test(msg), "error must name the fix");
    ok(/"workspace"/.test(msg), "error must show a correct example");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("forEach cannot name a shared workspace", () => {
  const dir = tmp();
  try {
    const p = writeManifest(dir, { tasks: [
      claudeTask({ id: "find" }),
      writerTask({ id: "fix", after: ["find"], workspace: "feat",
        forEach: { from: "find", path: "", maxItems: 5 } }),
    ] });
    const errs = errorsOf(() => loadManifest(p, CFG, dir));
    ok(errs.some((e) => /forEach.*shared workspace|shared workspace.*forEach/i.test(e)), JSON.stringify(errs));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("a shared workspace name cannot collide with another task's own tree", () => {
  const dir = tmp();
  try {
    const p = writeManifest(dir, { tasks: [
      writerTask({ id: "feat" }),
      writerTask({ id: "p1", workspace: "feat" }),
    ] });
    const errs = errorsOf(() => loadManifest(p, CFG, dir));
    ok(errs.some((e) => /collide|same path|already/i.test(e)), JSON.stringify(errs));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("a forEach task's future clone worktree cannot collide with a real task's own worktree", () => {
  const dir = tmp();
  try {
    const p = writeManifest(dir, { tasks: [
      claudeTask({ id: "find" }),
      writerTask({ id: "fix", after: ["find"],
        forEach: { from: "find", path: "", maxItems: 3 } }),
      // expandForEach will mint "fix"'s clones as fix-0/fix-1/fix-2 —
      // a real task that already owns "fix-1" must be rejected up front,
      // since neither name can be reserved against the other.
      writerTask({ id: "fix-1" }),
    ] });
    const errs = errorsOf(() => loadManifest(p, CFG, dir));
    ok(errs.some((e) => /forEach clone worktree "fix-1"/.test(e)), JSON.stringify(errs));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("links sharing a workspace must agree on their branch", () => {
  const dir = tmp();
  try {
    const p = writeManifest(dir, { tasks: [
      writerTask({ id: "impl", workspace: "feat", branch: "autonomous/x" }),
      writerTask({ id: "rev", after: ["impl"], workspace: "feat" }),
    ] });
    const errs = errorsOf(() => loadManifest(p, CFG, dir));
    ok(errs.some((e) => /disagree on their branch/.test(e) && /autonomous\/x/.test(e)), JSON.stringify(errs));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("links sharing a workspace with the SAME explicit branch are fine", () => {
  const dir = tmp();
  try {
    const p = writeManifest(dir, { tasks: [
      writerTask({ id: "impl", workspace: "feat", branch: "autonomous/x" }),
      writerTask({ id: "rev", after: ["impl"], workspace: "feat", branch: "autonomous/x" }),
    ] });
    equal(loadManifest(p, CFG, dir).tasks.length, 2);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("an ordered chain of three passes validation", () => {
  const dir = tmp();
  try {
    const p = writeManifest(dir, { tasks: [
      writerTask({ id: "p1", workspace: "feat" }),
      writerTask({ id: "rev", after: ["p1"], workspace: "feat" }),
      writerTask({ id: "p2", after: ["rev"], workspace: "feat" }),
    ] });
    const plan = loadManifest(p, CFG, dir);
    equal(plan.tasks.length, 3);
    deepEqual(plan.tasks.map((t) => t.worktreeName), ["feat", "feat", "feat"]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

import { resolveWorktreeName, realRepoToplevel } from "../src/manifest.mjs";
import { realpathSync } from "node:fs";
import { spawnSync } from "node:child_process";

test("resolveWorktreeName is the single rule every derivation site shares", () => {
  const W = "Read,Edit,Bash";
  equal(resolveWorktreeName({ id: "a" }), undefined, "a reader owns no tree");
  equal(resolveWorktreeName({ id: "a", allowedTools: W }), "a", "a writer's tree is its own id");
  equal(resolveWorktreeName({ id: "a", allowedTools: W, workspace: "feat" }), "feat");
  equal(resolveWorktreeName({ id: "a", workspace: "feat" }), undefined,
    "a workspace on a reader is refused at validation, so it derives nothing here either");
  equal(resolveWorktreeName({ id: "a", allowedTools: W, compute: "x" }), undefined);
  // Already-normalized tasks carry the derived field; it wins over re-derivation.
  equal(resolveWorktreeName({ id: "a", worktreeName: "feat" }), "feat");
});

test("integrate node: agentless, validated, normalized onto its target worktree", () => {
  const dir = tmp();
  try {
    const agentic = writeManifest(dir, { tasks: [
      writerTask({ id: "x" }),
      { id: "join", after: ["x"], provider: "claude", model: "claude-haiku-4-5-20251001", prompt: "merge it",
        integrate: { into: "feat", from: ["x"] } },
    ] }, "agentic.json");
    ok(errorsOf(() => loadManifest(agentic, CFG, dir))
      .some((e) => /integrate tasks are agentless/.test(e)));

    const notDep = writeManifest(dir, { tasks: [
      writerTask({ id: "x" }),
      { id: "join", integrate: { into: "feat", from: ["x"] } },
    ] }, "notdep.json");
    ok(errorsOf(() => loadManifest(notDep, CFG, dir))
      .some((e) => /must be a declared dependency/.test(e)));

    // A reader and a "no write tools" source are the same source now — the tools are what
    // give a tree — so one message covers both spellings.
    for (const [name, src] of [
      ["notree", claudeTask({ id: "x" })],
      ["nowritesrc", claudeTask({ id: "x", allowedTools: "Read,Grep,Glob" })],
    ]) {
      const bad = writeManifest(dir, { tasks: [
        src, { id: "join", after: ["x"], integrate: { into: "feat", from: ["x"] } },
      ] }, `${name}.json`);
      ok(errorsOf(() => loadManifest(bad, CFG, dir))
        .some((e) => /has no write tools, so it commits nothing and owns no branch to merge/.test(e)),
        `${name}: nothing to merge from a branch that never exists`);
    }

    const good = writeManifest(dir, { tasks: [
      claudeTask({ id: "x", allowedTools: "Read,Edit" }),
      claudeTask({ id: "y", allowedTools: "Bash" }),
      { id: "join", after: ["x", "y"], integrate: { into: "feat", from: ["x", "y"] } },
      writerTask({ id: "next", after: ["join"], workspace: "feat" }),
    ] }, "good.json");
    const plan = loadManifest(good, CFG, dir);
    const join = plan.tasks.find((t) => t.id === "join");
    equal(join.model, "integrate", "display sentinel — never dispatched");
    equal(join.worktreeName, "feat", "the node owns the target tree");
    deepEqual(join.integrate.from, ["x", "y"]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("agentless nodes reject outputDir", () => {
  const dir = tmp();
  try {
    const od = writeManifest(dir, { tasks: [
      writerTask({ id: "x" }),
      { id: "join", after: ["x"], integrate: { into: "feat", from: ["x"] }, outputDir: "out" },
    ] }, "od.json");
    ok(errorsOf(() => loadManifest(od, CFG, dir)).some((e) => /agentless.*outputDir/.test(e)),
      "integrate rejects outputDir");

    const odc = writeManifest(dir, { tasks: [
      claudeTask({ id: "a", prompt: "…return JSON" }),
      { id: "c", after: ["a"], compute: "deps['a']", outputDir: "out" },
    ] }, "odc.json");
    ok(errorsOf(() => loadManifest(odc, CFG, dir)).some((e) => /agentless.*outputDir/.test(e)),
      "compute rejects outputDir");

  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ── F1/F2: integrate.from over a forEach parent (foreach-integrate-fold-back) ──
// integrate MERGES named branches rather than basing a new tree off one, so a
// forEach parent's clone branches ('id[0]', 'id[1]', …) are exactly the kind of
// multi-branch source integrate already knows how to fold in. Only this
// rejection is lifted — isolation.from above still rejects, and the when-gated
// / no-write-tools sibling checks still fire (F2).
test("F1: integrate.from accepts a forEach parent", () => {
  const dir = tmp();
  try {
    const p = writeManifest(dir, { tasks: [
      claudeTask({ id: "src", prompt: "…return JSON list" }),
      claudeTask({ id: "fix", after: ["src"], allowedTools: "Read,Edit",
        forEach: { from: "src", path: "", maxItems: 3 }, prompt: "fix {{item}}" }),
      { id: "join", after: ["fix"], integrate: { into: "feat", from: ["fix"] } },
    ] }, "fi.json");
    const plan = loadManifest(p, CFG, dir);
    const join = plan.tasks.find((t) => t.id === "join");
    deepEqual(join.integrate.from, ["fix"], "the clone expansion happens at run time, not here");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("F2: integrate.from over a forEach parent still rejects when-gated / no-write-tools sources", () => {
  const dir = tmp();
  try {
    const gated = writeManifest(dir, { tasks: [
      claudeTask({ id: "src", prompt: "…return JSON list" }),
      claudeTask({ id: "fix", after: ["src"], allowedTools: "Read,Edit",
        forEach: { from: "src", path: "", maxItems: 3 }, prompt: "fix {{item}}",
        when: { from: "src", truthy: "ok" } }),
      { id: "join", after: ["fix"], integrate: { into: "feat", from: ["fix"] } },
    ] }, "gated.json");
    ok(errorsOf(() => loadManifest(gated, CFG, dir)).some((e) => /is when-gated/.test(e)),
      "a when-gated forEach source is still refused — its worktree may never exist");

    const noWrite = writeManifest(dir, { tasks: [
      claudeTask({ id: "src2", prompt: "…return JSON list" }),
      claudeTask({ id: "fix2", after: ["src2"], allowedTools: "Read,Grep",
        forEach: { from: "src2", path: "", maxItems: 3 }, prompt: "fix {{item}}" }),
      { id: "join2", after: ["fix2"], integrate: { into: "feat", from: ["fix2"] } },
    ] }, "nowrite.json");
    ok(errorsOf(() => loadManifest(noWrite, CFG, dir)).some((e) => /has no write tools/.test(e)),
      "a read-only forEach source is still refused — its clones commit nothing");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("F8: integrateCaps names the forEach cap an integrate node folds in", () => {
  const tasks = [
    { id: "src", provider: "claude", model: "claude-haiku-4-5-20251001" },
    { id: "fix", forEach: { from: "src", path: "", maxItems: 5 } },
    { id: "join", integrate: { into: "feat", from: ["fix"] } },
    { id: "plain", allowedTools: "Read,Edit,Bash" },
    { id: "join2", integrate: { into: "feat2", from: ["plain"] } },
  ];
  deepEqual(integrateCaps(tasks), ["join ≤ 5 branches (fix forEach)"]);
});

// ── leaf guards (swarm-leaf-guard-no-cargo) ────────────────────────────────────
// A stub io skips the real spawnSync/git — the probe/print/match machinery is
// under test, not any actual guard command or repo.
function stubIo(over = {}) {
  return { spawnSync: () => ({ status: 0, stderr: "" }), stdout: () => {}, ...over };
}

test("normalizeTasks: a task under a projects entry matching its repo name carries leafGuard; false opts out; any other value errors", () => {
  const dir = tmp();
  const name = basename(dir);
  try {
    const cfg = { ...CFG, provider: { allowedRoots: [dir] }, projects: [{ name, hooks: { preToolUse: "guard-cmd" } }] };

    const on = writeManifest(dir, { tasks: [claudeTask({ cwd: "." })] }, "on.json");
    const planOn = loadManifest(on, cfg, dir, { io: stubIo() });
    deepEqual(planOn.tasks[0].leafGuard, { name, command: "guard-cmd" });

    const off = writeManifest(dir, { tasks: [claudeTask({ cwd: ".", leafGuard: false })] }, "off.json");
    const planOff = loadManifest(off, cfg, dir, { io: stubIo() });
    equal(planOff.tasks[0].leafGuard, undefined);

    const badTrue = writeManifest(dir, { tasks: [claudeTask({ leafGuard: true })] }, "bad-true.json");
    ok(errorsOf(() => loadManifest(badTrue, cfg, dir, { io: stubIo() }))
      .some((e) => e.includes("task 'a'") && e.includes("leafGuard") && e.includes('"leafGuard": false')));

    const badStr = writeManifest(dir, { tasks: [claudeTask({ leafGuard: "off" })] }, "bad-str.json");
    ok(errorsOf(() => loadManifest(badStr, cfg, dir, { io: stubIo() }))
      .some((e) => e.includes("task 'a'") && e.includes("leafGuard") && e.includes('"leafGuard": false')));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("normalizeTasks: the repo name is resolved via io.repoToplevel (git seam), not the task's cwd path", () => {
  const dir = tmp();
  try {
    // repoToplevel reports a DIFFERENT path than dir; the project name must
    // match that reported repo's basename, not dir's own basename.
    const cfg = { ...CFG, provider: { allowedRoots: [dir, join(dir, "..", "reported-repo")] }, projects: [{ name: "reported-repo", hooks: { preToolUse: "guard-cmd" } }] };
    const p = writeManifest(dir, { tasks: [claudeTask({ cwd: "." })] });
    const plan = loadManifest(p, cfg, dir, { io: stubIo({ repoToplevel: () => join(dir, "..", "reported-repo") }) });
    deepEqual(plan.tasks[0].leafGuard, { name: "reported-repo", command: "guard-cmd" });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("normalizeTasks: project name match is case-insensitive on Windows", () => {
  const dir = tmp();
  const name = basename(dir);
  try {
    const cfg = { ...CFG, provider: { allowedRoots: [dir] }, projects: [{ name: name.toUpperCase(), hooks: { preToolUse: "guard-cmd" } }] };
    const p = writeManifest(dir, { tasks: [claudeTask({ cwd: "." })] });
    const plan = loadManifest(p, cfg, dir, { io: stubIo() });
    if (process.platform === "win32") {
      deepEqual(plan.tasks[0].leafGuard, { name: name.toUpperCase(), command: "guard-cmd" });
    } else {
      equal(plan.tasks[0].leafGuard, undefined);
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("compute, manifest and integrate nodes never carry a leafGuard even under a guarded project", () => {
  const dir = tmp();
  const name = basename(dir);
  try {
    const cfg = { ...CFG, provider: { allowedRoots: [dir] }, projects: [{ name, hooks: { preToolUse: "guard-cmd" } }] };
    writeFileSync(join(dir, "child.json"), JSON.stringify({ tasks: [claudeTask({ id: "leaf", cwd: "." })] }));
    const p = writeManifest(dir, { tasks: [
      claudeTask({ id: "x", allowedTools: "Read,Edit" }),
      claudeTask({ id: "y", allowedTools: "Bash" }),
      { id: "calc", after: ["x"], compute: "true" },
      { id: "sub", manifest: "child.json" },
      { id: "join", after: ["x", "y"], integrate: { into: "feat", from: ["x", "y"] } },
    ] });
    const plan = loadManifest(p, cfg, dir, { io: stubIo() });
    equal(plan.tasks.find((t) => t.id === "calc").leafGuard, undefined);
    equal(plan.tasks.find((t) => t.id === "join").leafGuard, undefined);
    equal(plan.tasks.find((t) => t.id === "sub").leafGuard, undefined, "the manifest node itself is agentless");
    // the child's own leaf tasks are real spawned leaves — they still inherit
    // the guard for whatever project their (inherited) cwd resolves to
    deepEqual(plan.tasks.find((t) => t.id === "sub").childPlan.tasks[0].leafGuard, { name, command: "guard-cmd" });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("leaf guard validate probe: a non-zero exit fails validation naming the project, command, exit code and stderr; runs once per distinct guard", () => {
  const dir = tmp();
  const name = basename(dir);
  try {
    const cfg = { ...CFG, provider: { allowedRoots: [dir] }, projects: [{ name, hooks: { preToolUse: "broken-guard" } }] };
    const calls = [];
    const io = stubIo({
      spawnSync: (command, opts) => {
        calls.push({ command, opts });
        return { status: 3, stderr: "guard blew up\n" };
      },
    });
    const p = writeManifest(dir, { tasks: [
      claudeTask({ id: "a", cwd: "." }),
      claudeTask({ id: "b", cwd: "." }),
    ] });
    const errs = errorsOf(() => loadManifest(p, cfg, dir, { io }));
    ok(errs.some((e) => e.includes(name) && e.includes("broken-guard") && e.includes("3") && e.includes("guard blew up")));
    equal(calls.length, 1, "the probe runs once per distinct guard, not per task");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("leaf guard: a passing probe prints one line per guarded task and an opt-out line for a task that declines it", () => {
  const dir = tmp();
  const name = basename(dir);
  try {
    const cfg = { ...CFG, provider: { allowedRoots: [dir] }, projects: [{ name, hooks: { preToolUse: "guard-cmd" } }] };
    const lines = [];
    const io = stubIo({ stdout: (line) => lines.push(line) });
    const p = writeManifest(dir, { tasks: [
      claudeTask({ id: "a", cwd: "." }),
      claudeTask({ id: "b", cwd: ".", leafGuard: false }),
    ] });
    loadManifest(p, cfg, dir, { io });
    ok(lines.includes(`leaf guard: ${name} → guard-cmd`));
    ok(lines.includes("leaf guard: off (task opt-out)"));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ── run home: keyed on the repo toplevel ─────────────────────────────────────
test("run home: a non-repo dispatch is refused with the cd <repo> instruction", () => {
  const dir = tmp();
  try {
    const p = writeManifest(dir, { tasks: [claudeTask()] });
    const errs = errorsOf(() => loadManifest(p, CFG, dir, { io: { repoToplevel: () => null } }));
    ok(errs.some((e) => e.includes("is not inside a git repository") && e.includes('swarm run "')), errs.join("\n"));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("run home: a non-repo dispatch is refused for a registry manifest too", () => {
  const dir = tmp();
  try {
    const p = writeManifest(dir, { tasks: [claudeTask()] });
    const errs = errorsOf(() => loadManifest(p, CFG, dir, { fromRegistry: true, io: { repoToplevel: () => null } }));
    ok(errs.some((e) => e.includes("is not inside a git repository")), errs.join("\n"));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

function withHome(dir, fn) {
  const prev = process.env.SWARM_HOME;
  process.env.SWARM_HOME = join(dir, "home");
  try { fn(); } finally {
    if (prev === undefined) delete process.env.SWARM_HOME; else process.env.SWARM_HOME = prev;
  }
}

// The run gate bounds the run's REPO, not just each leaf's cwd, so the fixtures below that
// stub a toplevel outside the tmpdir must let claude's roots cover the stubbed path.
const CFG_PROJ = { ...CFG, providers: { claude: { enabled: true, allowedRoots: [tmpdir(), "C:/proj"] } } };

test("run home: a subdirectory dispatch is filed under the repo toplevel's key", () => {
  const dir = tmp();
  try {
    withHome(dir, () => {
      const sub = join(dir, "sub");
      mkdirSync(sub);
      const p = writeManifest(dir, { tasks: [claudeTask()] }, "m.json");
      const plan = loadManifest(p, CFG_PROJ, sub, { io: { repoToplevel: () => "C:/proj/repo" } });
      equal(plan.resultsDir, join(dir, "home", "runs", "C--proj-repo", "m-1"));
    });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("run home: dispatches from the toplevel and a subdirectory resume the same run", () => {
  const dir = tmp();
  try {
    withHome(dir, () => {
      const sub = join(dir, "sub");
      mkdirSync(sub);
      mkdirSync(join(dir, "home", "runs", "C--proj-repo", "m-1"), { recursive: true });
      const p = writeManifest(dir, { tasks: [claudeTask()] }, "m.json");
      const io = { repoToplevel: () => "C:/proj/repo" };
      const want = join(dir, "home", "runs", "C--proj-repo", "m-1");
      equal(loadManifest(p, CFG_PROJ, dir, { io }).resultsDir, want);
      equal(loadManifest(p, CFG_PROJ, sub, { io }).resultsDir, want);
    });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("run home: allowedRoots bounds the repo for a Claude-only manifest too", () => {
  const dir = tmp();
  try {
    withHome(dir, () => {
      // Claude's OWN roots, nested spelling — the legacy top-level `provider` key resolves
      // onto ollama and has no say over a Claude-only run.
      const root = join(dir, "root");
      const inside = join(root, "repo");
      mkdirSync(inside, { recursive: true });
      const cfg = { ...CFG, providers: { claude: { enabled: true, allowedRoots: [root] } } };
      const p = writeManifest(dir, { tasks: [claudeTask({ cwd: inside })] });
      const outside = join(dir, "elsewhere");
      const errs = errorsOf(() => loadManifest(p, cfg, inside, { io: { repoToplevel: () => outside } }));
      ok(errs.some((e) => e.includes(`this run's repo '${outside}'`) && e.includes("providers.claude.allowedRoots") && e.includes(root)), errs.join("\n"));
      loadManifest(p, cfg, inside, { io: { repoToplevel: () => inside } });
    });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// Fail-open by design, as it always was: no roots declared for the providers a run seats
// states no policy, so the run gate adds nothing. checkGovernance still denies every leaf
// whose provider has no roots — the run is refused, just not by this gate.
test("run home: absent or empty allowedRoots leaves the run gate inert", () => {
  const dir = tmp();
  try {
    withHome(dir, () => {
      const p = writeManifest(dir, { tasks: [claudeTask()] });
      const io = { repoToplevel: () => join(dir, "anywhere") };
      const configs = [{ claude: { enabled: true } }, { claude: { enabled: true, allowedRoots: [] } }];
      for (const providers of configs) {
        const errs = errorsOf(() => loadManifest(p, { ...CFG, providers }, dir, { io }));
        ok(!errs.some((e) => e.includes("this run's repo")), errs.join("\n"));
      }
    });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// Real git, not the io stub: the stub IS realRepoToplevel's replacement, so only a
// genuine linked worktree can turn this red. Under `rev-parse --show-toplevel` the
// worktree answers with itself and the run home nests inside a previous run's tree.
test("realRepoToplevel: a linked worktree resolves to the MAIN worktree, not itself", () => {
  const dir = realpathSync(tmp());
  try {
    const repo = join(dir, "repo");
    mkdirSync(repo);
    const git = (args, cwd = repo) => {
      const r = spawnSync("git", args, { cwd, encoding: "utf8" });
      if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
      return r.stdout;
    };
    git(["init", "-q", "-b", "main"]);
    git(["config", "user.email", "t@t"]);
    git(["config", "user.name", "t"]);
    writeFileSync(join(repo, "a.txt"), "a\n");
    git(["add", "-A"]);
    git(["commit", "-qm", "init"]);

    const wt = join(dir, "wt");
    git(["worktree", "add", "-q", "-b", "side", wt]);

    const norm = (p) => p.split("\\").join("/");
    equal(norm(realRepoToplevel(wt)), norm(repo));
    equal(norm(realRepoToplevel(repo)), norm(repo));

    // A nested dir inside the linked worktree resolves the same way.
    const deep = join(wt, "sub");
    mkdirSync(deep);
    equal(norm(realRepoToplevel(deep)), norm(repo));

    git(["worktree", "remove", "--force", wt]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("realRepoToplevel: outside a repo is null", () => {
  const dir = realpathSync(tmp());
  try {
    equal(realRepoToplevel(dir), null);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ---- the one derivation: rows pinned to literals / the independent run-scope oracle ----
import { effectivePlanDoc } from "../src/manifest.mjs";
import { oracleSnapKey } from "./helpers/snap-key.mjs";

const bashTask = (over = {}) => ({ id: "impl", prompt: "p", provider: "claude", model: "claude-haiku-4-5-20251001", allowedTools: "Read,Bash", ...over });
const inDir = (dir, body, name, opts) => loadManifest(writeManifest(dir, body, name), CFG, dir, opts);

test("branchScope: every writer carries the run-scoped key, however its tree was named; readers carry none", () => {
  const dir = tmp();
  try {
    const plan = inDir(dir, { tasks: [
      bashTask(),
      claudeTask({ id: "rd" }),
      bashTask({ id: "ex", workspace: "shared" }),
    ] });
    const by = Object.fromEntries(plan.tasks.map((t) => [t.id, t]));
    ok(/^[0-9a-f]{12}$/.test(by.impl.branchScope), by.impl.branchScope);
    equal(by.impl.branchScope, oracleSnapKey(plan.resultsDir));
    equal(by.impl.branchName, undefined);
    equal(by.rd.branchScope, undefined, "a reader owns no branch to scope");
    // The row the plan exists for: naming the tree must not change the derivation.
    equal(by.ex.branchScope, oracleSnapKey(plan.resultsDir));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("branchScope: a forEach writer synthesises worktreeName so clones can be renamed, and no fixed branchName", () => {
  const dir = tmp();
  try {
    const plan = inDir(dir, { tasks: [
      claudeTask({ id: "src" }),
      bashTask({ id: "fe", after: ["src"], forEach: { from: "src", path: "sites", maxItems: 2 } }),
    ] });
    const fe = plan.tasks.find((t) => t.id === "fe");
    equal(fe.worktreeName, "fe");
    equal(fe.branchName, undefined);
    equal(fe.branchScope, oracleSnapKey(plan.resultsDir));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a writer beside a workspace of the same name is a collision; a reader is not", () => {
  const dir = tmp();
  try {
    const errs = errorsOf(() => inDir(dir, { tasks: [
      bashTask(),
      bashTask({ id: "other", workspace: "impl" }),
    ] }));
    ok(errs.some((e) => e.includes("collides with task 'impl'")), errs.join("\n"));
    const plan = inDir(dir, { tasks: [
      claudeTask({ id: "impl" }),
      bashTask({ id: "other", workspace: "impl" }),
    ] }, "ok.json");
    equal(plan.tasks.length, 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a reader is normalised with no tree and its cwd untouched", () => {
  const dir = tmp();
  try {
    const t = inDir(dir, { tasks: [claudeTask()] }).tasks[0];
    equal(t.worktreeName, undefined);
    equal(t.branchScope, undefined);
    equal(t.repoToplevel, undefined, "a reader needs no repo: it is not getting a tree from one");
    equal(t.cwd, t.originalCwd);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a reader outside any repo loads: only a writer needs one", () => {
  // RED: apply the repo check to every leaf and a leaf reading a non-repo directory —
  // logs, a data dump — is refused for wanting a tree it never asked for.
  const dir = tmp();
  const bare = join(dir, "bare");
  mkdirSync(bare);
  const top = (c) => (c === bare ? null : dir), io = { repoToplevel: top, checkoutToplevel: top };
  try {
    equal(loadManifest(writeManifest(dir, { tasks: [claudeTask({ cwd: bare })] }), CFG, dir, { io }).tasks.length, 1);

    const errs = errorsOf(() => loadManifest(
      writeManifest(dir, { tasks: [bashTask({ cwd: bare })] }, "w.json"), CFG, dir, { io }));
    ok(errs.some((e) => e.includes("is not inside a git repository") && e.includes("drop the write tools")), errs.join("\n"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("effectivePlanDoc records what was authored: workspace and branch kept, nothing synthesised", () => {
  const dir = tmp();
  try {
    const plan = inDir(dir, { tasks: [
      claudeTask({ id: "rd" }),
      bashTask({ id: "wr" }),
      bashTask({ id: "ws", workspace: "feat" }),
      bashTask({ id: "br", branch: "autonomous/x" }),
    ] });
    const by = Object.fromEntries(effectivePlanDoc(plan).tasks.map((t) => [t.id, t]));
    equal("workspace" in by.rd, false);
    equal("workspace" in by.wr, false, "a derived tree is not authored, so it is not recorded");
    equal(by.ws.workspace, "feat");
    equal(by.br.branch, "autonomous/x");
    for (const t of Object.values(by)) equal("isolationMode" in t, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("two default readers with no after: neither owns a worktree name, so they are not an ordered group", () => {
  const dir = tmp();
  try {
    const plan = inDir(dir, { tasks: [claudeTask({ id: "r1" }), claudeTask({ id: "r2" })] });
    const by = Object.fromEntries(plan.tasks.map((t) => [t.id, t]));
    for (const id of ["r1", "r2"]) {
      equal("worktreeName" in by[id], false, "a shared name would make two parallel readers a chain");
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a forEach writer's clone names collide with a workspace sibling", () => {
  const dir = tmp();
  try {
    const errs = errorsOf(() => inDir(dir, { tasks: [
      claudeTask({ id: "src", prompt: "…return JSON list" }),
      bashTask({ id: "fix", after: ["src"], forEach: { from: "src", path: "", maxItems: 2 },
        prompt: "fix {{item}}" }),
      bashTask({ id: "other", workspace: "fix-1" }),
    ] }));
    ok(errs.some((e) => e.includes('forEach clone worktree "fix-1" would collide')), errs.join("\n"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("integrate.from: a reader has no branch to merge; a writer does", () => {
  const dir = tmp();
  try {
    const errs = errorsOf(() => inDir(dir, { tasks: [
      claudeTask({ id: "x" }),
      { id: "join", after: ["x"], integrate: { into: "feat", from: ["x"] } },
    ] }));
    ok(errs.some((e) => e.includes("integrate.from 'x' has no write tools")), errs.join("\n"));

    const plan = inDir(dir, { tasks: [
      bashTask({ id: "x" }),
      { id: "join", after: ["x"], integrate: { into: "feat", from: ["x"] } },
    ] }, "ok.json");
    deepEqual(plan.tasks.find((t) => t.id === "join").integrate.from, ["x"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("loadManifest records the dispatching repo on the plan", () => {
  const dir = tmp();
  try {
    equal(inDir(dir, { tasks: [claudeTask()] }).repoToplevel, dir, "the run is filed under this tree");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a writer in a second repo carries THAT repo, while the run stays filed under the dispatching one", () => {
  const dir = tmp(), other = tmp();
  try {
    mkdirSync(join(dir, "sub"), { recursive: true });
    // Two real repos: the dispatch cwd and the task's own.
    const top = (d) => (String(d).startsWith(other) ? other : dir), io = { repoToplevel: top, checkoutToplevel: top };
    const plan = inDir(dir, { tasks: [
      bashTask({ id: "here" }),
      bashTask({ id: "there", cwd: other }),
    ] }, "two.json", { io });
    const by = Object.fromEntries(plan.tasks.map((t) => [t.id, t]));
    equal(by.here.repoToplevel, dir);
    equal(by.there.repoToplevel, other);
    notEqual(by.there.repoToplevel, by.here.repoToplevel, "one repo for both branches the wrong tree");
    equal(plan.repoToplevel, dir, "the run is filed under the dispatching repo, not the task's");
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(other, { recursive: true, force: true });
  }
});

test("writers sharing a cwd ask git for its toplevel once, not once per task", () => {
  const dir = tmp();
  try {
    const sub = join(dir, "sub");
    mkdirSync(sub, { recursive: true });
    const calls = [];
    const io = { repoToplevel: () => dir, checkoutToplevel: (d) => { calls.push(String(d)); return dir; } };
    const tasks = Array.from({ length: 10 }, (_, i) => bashTask({ id: `t${i}`, cwd: "sub" }));
    inDir(dir, { tasks }, "memo.json", { io });
    equal(calls.filter((d) => d === sub).length, 1,
      "no memo means one `git rev-parse` per leaf at normalise time — slow, and invisible to every other test");
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

// --- workspace and branch: the whole isolation surface ------------------------

const writer = (over = {}) => claudeTask({ allowedTools: "Read,Edit,Bash", ...over });

test("workspace: a writer gets one tree named by it, on a run-scoped branch", () => {
  const dir = tmp();
  try {
    const p = writeManifest(dir, { tasks: [writer({ workspace: "feat" })] });
    const [t] = loadManifest(p, CFG, dir).tasks;
    equal(t.worktreeName, "feat");
    ok(t.branchScope, "a derived branch is run-scoped so a kept tree cannot block the next run");
    equal(t.repoToplevel !== undefined, true);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("workspace: naming your own id is identical to writing nothing", () => {
  // RED: reintroduce a second derivation branch for the explicit spelling and these diverge.
  // Deep-equal on the WHOLE task, not a field list — a field list missed branchScope last time.
  // One manifest, so both tasks share a resultsDir and therefore a run scope; only the id
  // is expected to differ.
  const dir = tmp();
  try {
    const p = writeManifest(dir, { tasks: [
      writer({ id: "silent" }),
      writer({ id: "named", workspace: "named", after: ["silent"] }),
    ] });
    const [silent, named] = loadManifest(p, CFG, dir).tasks;
    // The authored keys and the ids differ by construction; every DERIVED field must not.
    // The write guard's allowed root IS the task's own tree, so it differs exactly where
    // worktreeName does — normalise that one substring rather than dropping `settings`,
    // so any other divergence in the block still fails.
    const derivedOnly = (t) => {
      const { id, after, workspace, worktreeName, ...rest } = t;
      return JSON.parse(JSON.stringify(rest).split(`wt-${worktreeName}`).join("wt-<name>"));
    };
    deepEqual(derivedOnly(named), derivedOnly(silent));
    // And the names still agree, so the two spellings really do describe one tree.
    equal(named.worktreeName, "named");
    equal(silent.worktreeName, "silent");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("workspace: a reader gets no tree and reads its own cwd", () => {
  const dir = tmp();
  try {
    const p = writeManifest(dir, { tasks: [claudeTask()] });
    const [t] = loadManifest(p, CFG, dir).tasks;
    equal(t.worktreeName, undefined, "a reader owns no tree");
    equal(t.branchScope, undefined);
    equal(t.cwd, t.originalCwd, "a reader reads the live repo where it was pointed");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("workspace: isolation is rejected by name and taught workspace", () => {
  const dir = tmp();
  try {
    for (const iso of ["worktree", "none", { worktree: "feat" }]) {
      const p = writeManifest(dir, { tasks: [writer({ isolation: iso })] }, `x${JSON.stringify(iso).length}.json`);
      const errs = errorsOf(() => loadManifest(p, CFG, dir)).join("\n");
      ok(/isolation/.test(errs), `names the dead key for ${JSON.stringify(iso)}`);
      ok(/workspace/.test(errs), `names the replacement for ${JSON.stringify(iso)}`);
      ok(/"workspace":\s*"/.test(errs), `shows a correct example for ${JSON.stringify(iso)}`);
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("workspace: a path-escaping name is refused — it becomes a directory and a branch", () => {
  const dir = tmp();
  try {
    const p = writeManifest(dir, { tasks: [writer({ workspace: "../escape" })] });
    ok(errorsOf(() => loadManifest(p, CFG, dir)).join("\n").match(/filename-safe/));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("workspace: unordered members of one workspace are refused, naming both", () => {
  const dir = tmp();
  try {
    const p = writeManifest(dir, { tasks: [
      writer({ id: "a", workspace: "feat" }),
      writer({ id: "b", workspace: "feat" }),
    ] });
    const errs = errorsOf(() => loadManifest(p, CFG, dir)).join("\n");
    ok(!/unknown key/.test(errs), `must fail on the ordering rule, not the key allowlist: ${errs}`);
    ok(/\ba\b/.test(errs) && /\bb\b/.test(errs), errs);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("workspace: ordered members of one workspace share it", () => {
  const dir = tmp();
  try {
    const p = writeManifest(dir, { tasks: [
      writer({ id: "a", workspace: "feat" }),
      writer({ id: "b", workspace: "feat", after: ["a"] }),
    ] });
    const ts = loadManifest(p, CFG, dir).tasks;
    deepEqual(ts.map((t) => t.worktreeName), ["feat", "feat"]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("branch: an explicit name is carried verbatim and opts out of run scoping", () => {
  // RED: drop branchName from the normalised task, or keep scoping it — either
  // makes the key decorative, which is the defect class this plan is about.
  const dir = tmp();
  try {
    const p = writeManifest(dir, { tasks: [writer({ branch: "swarm/eco-p3" })] });
    const [t] = loadManifest(p, CFG, dir).tasks;
    equal(t.branchName, "swarm/eco-p3");
    equal(t.branchScope, undefined, "naming a stable branch IS opting out of the run scope");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("branch: refused on a reader, which owns no branch", () => {
  const dir = tmp();
  try {
    const p = writeManifest(dir, { tasks: [claudeTask({ branch: "swarm/x" })] });
    const errs = errorsOf(() => loadManifest(p, CFG, dir)).join("\n");
    ok(!/unknown key/.test(errs), `branch is a known key; it must be refused on the reader: ${errs}`);
    ok(/branch/.test(errs), errs);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("workspace: refused on the agentless nodes, not silently ignored", () => {
  const dir = tmp();
  try {
    for (const [name, over] of [
      ["compute", { compute: "deps['a'].x" }],
      ["integrate", { integrate: { into: "feat", from: ["a"] } }],
    ]) {
      const p = writeManifest(dir, { tasks: [
        writer({ id: "a" }),
        { id: "n", after: ["a"], workspace: "feat", ...over },
      ] }, `${name}.json`);
      const errs = errorsOf(() => loadManifest(p, CFG, dir)).join("\n");
      ok(!/unknown key 'workspace'/.test(errs), `${name} must reject it as agentless, not as unknown: ${errs}`);
      ok(/workspace/.test(errs), `${name} must name workspace: ${errs}`);
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ── leaf write guard ──────────────────────────────────────────────────────────
// A worktree confines a leaf's cwd, not an absolute path: the 2026-08-28 incident
// was a compacted leaf writing across the operator's live checkout. The guard is
// INJECTED into each writer's own `--settings`, so the leaf cannot rewrite it.

test("write guard: attached to a write-capable leaf, rooted at its own worktree", () => {
  const dir = tmp();
  try {
    const p = writeManifest(dir, { resultsDir: "out", tasks: [writerTask()] });
    const plan = loadManifest(p, CFG, dir);
    const guard = plan.tasks[0].settings?.hooks?.PreToolUse?.[0];
    ok(guard, `a writer must carry the guard: ${JSON.stringify(plan.tasks[0].settings)}`);
    equal(guard.matcher, "Write|Edit|NotebookEdit");
    const command = guard.hooks[0].command;
    match(command, /leaf-write-guard\.mjs/);
    // The root is the worktree the scheduler will create for this task.
    match(command, /wt-a/);
    equal(guard.hooks[0].type, "command");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("write guard: absent from a read-only leaf, which has no tree to be confined to", () => {
  const dir = tmp();
  try {
    const p = writeManifest(dir, { resultsDir: "out", tasks: [claudeTask()] });
    const plan = loadManifest(p, CFG, dir);
    equal(plan.tasks[0].allowedTools, DEFAULT_TOOLS);
    equal(plan.tasks[0].settings, undefined);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("write guard: absent from a read-only leaf even when it declares an outputDir", () => {
  // The row above passes on its own for the wrong reason: a reader derives no tree,
  // so its root list is empty and applyWriteGuard no-ops. outputDir is the one root a
  // reader CAN have, which makes hasWriteTools the only thing withholding the guard.
  const dir = tmp();
  try {
    const p = writeManifest(dir, { resultsDir: "out", tasks: [claudeTask({ outputDir: "artefacts" })] });
    const plan = loadManifest(p, CFG, dir);
    equal(plan.tasks[0].outputDir, join(dir, "artefacts"), "the root would exist if the predicate let it through");
    equal(plan.tasks[0].settings, undefined);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("write guard: outputDir is a second allowed root — it resolves into the live checkout", () => {
  const dir = tmp();
  try {
    const p = writeManifest(dir, { resultsDir: "out", tasks: [writerTask({ outputDir: "artefacts" })] });
    const plan = loadManifest(p, CFG, dir);
    const command = plan.tasks[0].settings.hooks.PreToolUse[0].hooks[0].command;
    match(command, /wt-a/);
    match(command, /artefacts/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("write guard: a task's own hooks cannot replace it", () => {
  const dir = tmp();
  try {
    const own = { matcher: "Bash", hooks: [{ type: "command", command: "node mine.mjs" }] };
    const p = writeManifest(dir, { resultsDir: "out", tasks: [writerTask({
      settings: { env: { OTHER: "x" }, hooks: { PreToolUse: [own], Stop: [{ hooks: [{ type: "command", command: "node stop.mjs" }] }] } },
    })] });
    const plan = loadManifest(p, CFG, dir);
    const hooks = plan.tasks[0].settings.hooks;
    equal(hooks.PreToolUse.length, 2, "the engine's entry is prepended, not replaced");
    equal(hooks.PreToolUse[0].matcher, "Write|Edit|NotebookEdit");
    deepEqual(hooks.PreToolUse[1], own, "the task's own entry survives beside it");
    ok(hooks.Stop, "unrelated hook events survive");
    equal(plan.tasks[0].settings.env.OTHER, "x", "unrelated settings survive");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("write guard: the emitted command actually denies when a shell runs it", () => {
  // Every other row asserts the command as a STRING; a wrong hook path or a root
  // list that never made it into the command would pass all of them. This runs it.
  const dir = tmp();
  try {
    const p = writeManifest(dir, { resultsDir: "out", tasks: [writerTask()] });
    const command = loadManifest(p, CFG, dir).tasks[0].settings.hooks.PreToolUse[0].hooks[0].command;
    const payload = (filePath) => JSON.stringify({ tool_name: "Write", tool_input: { file_path: filePath } });
    const run = (filePath) => {
      const r = spawnSync(command, { shell: true, input: payload(filePath), encoding: "utf8" });
      equal(r.status, 0, `the emitted command must run — ${r.stderr}`);
      return r.stdout.trim();
    };
    const root = join(dir, "out", "wt-a");
    equal(run(join(root, "inside.txt")), "", "a write inside the leaf's own tree is allowed");
    const out = JSON.parse(run(join(dir, "escape.txt")));
    equal(out.hookSpecificOutput.permissionDecision, "deny", "a write outside it is denied");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("write guard: present on the report-mode digest, absent on the read-only one", () => {
  const dir = tmp();
  try {
    const body = (report) => ({
      resultsDir: "out",
      tasks: [claudeTask()],
      digest: { provider: "claude", model: "claude-haiku-4-5-20251001", ...(report && { report: true }) },
    });

    const p1 = writeManifest(dir, body(false), "plain.json");
    equal(buildDigestTask(loadManifest(p1, CFG, dir)).settings, undefined, "a Read-only digest writes nothing to guard");

    const p2 = writeManifest(dir, body(true), "report.json");
    const plan = loadManifest(p2, CFG, dir);
    const digestTask = buildDigestTask(plan);
    const command = digestTask.settings?.hooks?.PreToolUse?.[0]?.hooks?.[0]?.command;
    ok(command, `the report digest holds Write, so it must carry the guard: ${JSON.stringify(digestTask.settings)}`);
    match(command, /leaf-write-guard\.mjs/);
    // Its drafting directory and the one file it may write.
    match(command, /scratch-__digest/);
    match(command, /report\.md/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
