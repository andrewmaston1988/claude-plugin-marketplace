// The manifest core: what a well-formed manifest normalises to, and every shape
// rule that refuses one — ids, dependencies, templates, settings, effort, the
// tree a leaf's write tools imply, and the default results directory.
//
// The remaining concerns live beside this file, one suite each: provider policy,
// digest, headroom, deterministic steps, composition, args, workspace, integrate,
// helpers, leaf guards, run home and relations.
import { test } from "node:test";
import { equal, ok, deepEqual, throws } from "node:assert/strict";
import { writeFileSync, rmSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { ValidationError, DEFAULT_TOOLS } from "../src/manifest.mjs";
import { loadManifest } from "./helpers/repo-io.mjs";
import { CFG, writeManifest, tmp, errorsOf, claudeTask } from "./helpers/manifest-fixtures.mjs";

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
