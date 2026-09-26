import { test } from "node:test";
import { equal, ok } from "node:assert/strict";
import { writeFileSync, readFileSync, rmSync, mkdirSync } from "node:fs";
import { basename, join } from "node:path";
import { loadManifest } from "./helpers/repo-io.mjs";
import { CFG, writeManifest, tmp, errorsOf, claudeTask } from "./helpers/manifest-fixtures.mjs";

// ── governance gate ───────────────────────────────────────────────────────────

test("governance: open-model task outside allowedRoots rejected with data governance message", () => {
  const dir = tmp();
  try {
    const p = writeManifest(dir, {
      tasks: [{ id: "o", prompt: "p", provider: "ollama", model: "minimax-m3:cloud" }],
    });
    const errs = errorsOf(() => loadManifest(p, CFG, dir)); // allowedRoots: []
    ok(errs.some((e) => e.includes("data governance")), errs.join("|"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("governance: open-model task under an allowed root passes", () => {
  const dir = tmp();
  try {
    const p = writeManifest(dir, {
      tasks: [{ id: "o", prompt: "p", provider: "ollama", model: "minimax-m3:cloud" }],
    });
    const cfg = { ...CFG, provider: { allowedRoots: [dir] } };
    const plan = loadManifest(p, cfg, dir);
    equal(plan.tasks[0].model, "minimax-m3:cloud");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("governance: task.cwd (not process cwd) is what's checked", () => {
  const dir = tmp();
  try {
    const inside = join(dir, "allowed", "repo");
    mkdirSync(inside, { recursive: true });
    const p = writeManifest(dir, {
      tasks: [{ id: "o", prompt: "p", provider: "ollama", model: "minimax-m3:cloud", cwd: inside }],
    });
    const cfg = { ...CFG, provider: { allowedRoots: [join(dir, "allowed")] } };
    const plan = loadManifest(p, cfg, inside);
    equal(plan.tasks[0].cwd, inside);

    const outside = writeManifest(dir, {
      tasks: [{ id: "o", prompt: "p", provider: "ollama", model: "minimax-m3:cloud", cwd: dir }],
    }, "outside.json");
    const errs = errorsOf(() => loadManifest(outside, cfg, inside));
    ok(errs.some((e) => e.includes("data governance")));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("governance: Claude task anywhere passes with empty allowedRoots", () => {
  const dir = tmp();
  try {
    const p = writeManifest(dir, {
      tasks: [
        claudeTask({ id: "h", provider: "claude", model: "claude-haiku-4-5-20251001" }),
        claudeTask({ id: "c", provider: "claude", model: "claude-opus-4-8" }),
      ],
    });
    const plan = loadManifest(p, CFG, dir);
    equal(plan.tasks.length, 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// The run-level gate must judge the run's repo against the roots of the providers the
// manifest SEATS. It read `cfg.provider` — the legacy getter onto providers.ollama — so a
// claude-only run was refused whenever ollama's roots happened not to cover the repo.
test("governance: run-level gate reads the seated provider's roots, not ollama's", () => {
  const repo = tmp();
  const elsewhere = tmp();
  try {
    const cfg = {
      ...CFG,
      // The legacy spelling resolves to ollama's block — this is what the old gate read.
      provider: { allowedRoots: [elsewhere] },
      providers: {
        claude: { enabled: true, allowedRoots: [repo] },
        ollama: { enabled: true, allowedRoots: [elsewhere] },
      },
    };
    const p = writeManifest(repo, { tasks: [claudeTask()] });
    const plan = loadManifest(p, cfg, repo);
    equal(plan.tasks[0].provider, "claude");
  } finally {
    rmSync(repo, { recursive: true, force: true });
    rmSync(elsewhere, { recursive: true, force: true });
  }
});

// The union reading: a seated provider whose own roots miss the repo does not veto the run
// when another seated provider's roots cover it. Every task is still gated individually.
test("governance: run-level gate passes on the UNION of seated providers' roots", () => {
  const parent = tmp();
  const repo = join(parent, "repo");
  const other = tmp();
  try {
    mkdirSync(repo, { recursive: true });
    const cfg = {
      ...CFG,
      provider: { allowedRoots: [other] },
      providers: {
        claude: { enabled: true, allowedRoots: [parent] },
        ollama: { enabled: true, allowedRoots: [other] },
      },
    };
    const p = writeManifest(repo, {
      tasks: [
        claudeTask({ id: "c", cwd: repo }),
        { id: "o", prompt: "inspect", provider: "ollama", model: "glm-5.3:cloud", cwd: other },
      ],
    });
    const plan = loadManifest(p, cfg, repo);
    equal(plan.tasks.length, 2);
  } finally {
    rmSync(parent, { recursive: true, force: true });
    rmSync(other, { recursive: true, force: true });
  }
});

// The converse: outside every seated provider's roots is still refused, and the message
// names a key the config actually has.
test("governance: run-level gate still refuses a repo outside every seated provider's roots", () => {
  const repo = tmp();
  const elsewhere = tmp();
  try {
    const cfg = {
      ...CFG,
      provider: { allowedRoots: [elsewhere] },
      providers: { claude: { enabled: true, allowedRoots: [elsewhere] } },
    };
    const p = writeManifest(repo, { tasks: [claudeTask()] });
    const errs = errorsOf(() => loadManifest(p, cfg, repo));
    ok(
      errs.some((e) => e.includes(`this run's repo '${repo}'`) && e.includes("providers.claude.allowedRoots")),
      errs.join("|")
    );
  } finally {
    rmSync(repo, { recursive: true, force: true });
    rmSync(elsewhere, { recursive: true, force: true });
  }
});

// The gate must fire before anything SPAWNS. normalizeTasks probes a project's configured
// preToolUse hook with cwd in the run's repo, so a gate placed after it executes an operator
// command inside the very repo it is about to refuse.
// RED when the root check sits after normalizeTasks: spawnSync records a call.
test("governance: the run-level gate refuses before any guard hook is spawned", () => {
  const repo = tmp();
  const elsewhere = tmp();
  try {
    const cfg = {
      ...CFG,
      providers: { claude: { enabled: true, allowedRoots: [elsewhere] } },
      projects: [{ name: basename(repo), hooks: { preToolUse: "guard-cmd" } }],
    };
    const spawned = [];
    const p = writeManifest(repo, { tasks: [claudeTask()] });
    const errs = errorsOf(() => loadManifest(p, cfg, repo, {
      io: {
        repoToplevel: () => repo,
        spawnSync: (cmd) => { spawned.push(cmd); return { status: 0, stderr: "" }; },
        stdout: () => {},
      },
    }));
    ok(errs.some((e) => e.includes(`this run's repo '${repo}'`)), errs.join("|"));
    equal(spawned.length, 0, `guard hook ran in a refused repo: ${spawned.join(",")}`);
  } finally {
    rmSync(repo, { recursive: true, force: true });
    rmSync(elsewhere, { recursive: true, force: true });
  }
});

// An agentless-only manifest seats no provider, but integrate nodes still run real git
// merges against the run's repo. Seating nobody must not mean gating on nothing.
// RED when the gate keys off seated providers alone: seatedRoots is empty, so it never fires.
test("governance: an integrate-only manifest is still bounded by allowedRoots", () => {
  const repo = tmp();
  const elsewhere = tmp();
  try {
    const cfg = {
      ...CFG,
      providers: {
        claude: { enabled: true, allowedRoots: [elsewhere] },
        ollama: { enabled: true, allowedRoots: [elsewhere] },
      },
    };
    const p = writeManifest(repo, {
      tasks: [{ id: "join", integrate: { into: "feat", from: ["feat"] } }],
    });
    const errs = errorsOf(() => loadManifest(p, cfg, repo));
    ok(errs.some((e) => e.includes(`this run's repo '${repo}'`)), errs.join("|"));
  } finally {
    rmSync(repo, { recursive: true, force: true });
    rmSync(elsewhere, { recursive: true, force: true });
  }
});

// A provider with NO allowedRoots at all is UNCONFIGURED, not mis-located. Every cwd fails
// the check, so "dispatch from a repo under <list>" names an empty list and teaches nothing.
// This is exactly what a fresh install hits: config.default.json ships claude with no
// allowedRoots, and dropping the Claude exemption made that deny every task.
// RED while the refusal does not separate the two cases: it offers no setup route.
test("governance: a provider with no allowedRoots is diagnosed as unconfigured, pointing at setup", () => {
  const repo = tmp();
  try {
    const cfg = { ...CFG, providers: { claude: { enabled: true } } };
    const p = writeManifest(repo, { tasks: [claudeTask()] });
    const msg = errorsOf(() => loadManifest(p, cfg, repo)).join("|");
    ok(msg.includes("/swarm:swarm setup"), "no setup route offered: " + msg);
    ok(/has no .*allowedRoots configured/i.test(msg), "not diagnosed as unconfigured: " + msg);
    ok(!msg.includes("dispatch from a repo under  "), "names an empty root list: " + msg);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

// The shipped default config must either dispatch or say exactly how to fix itself. No
// fixture-based test can catch this — every other row supplies its own roots, which is why
// 1380 green tests sat on top of a plugin that refused every task on a clean install.
test("governance: the SHIPPED default config refuses with a setup route, not a bare denial", () => {
  const repo = tmp();
  try {
    const shipped = JSON.parse(readFileSync(new URL("../config.default.json", import.meta.url), "utf8"));
    const msg = errorsOf(() => loadManifest(writeManifest(repo, { tasks: [claudeTask()] }), shipped, repo)).join("|");
    ok(msg.length > 0, "shipped default unexpectedly dispatches with no roots configured");
    ok(msg.includes("/swarm:swarm setup"), "shipped default gives no setup route: " + msg);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});


test("governance: non-Claude digest model outside roots rejected", () => {
  const dir = tmp();
  try {
    const p = writeManifest(dir, {
      tasks: [claudeTask()],
      digest: { provider: "ollama", model: "glm-4.6:cloud" },
    });
    const errs = errorsOf(() => loadManifest(p, CFG, dir));
    ok(errs.some((e) => e.startsWith("digest") && e.includes("data governance")), errs.join("|"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});


test("governance checks the ORIGINAL cwd, not the worktree the leaf runs in", () => {
  const dir = tmp();
  try {
    const p = writeManifest(dir, {
      tasks: [{ id: "o", prompt: "p", provider: "ollama", model: "glm-4.6:cloud", allowedTools: "Write" }],
    });
    // the worktree lands under resultsDir — but the original cwd (dir)
    // is outside allowedRoots, so it must still be denied.
    const errs = errorsOf(() => loadManifest(p, CFG, dir));
    ok(errs.some((e) => e.includes("data governance")));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});


test("governance gates child tasks exactly like inline tasks", () => {
  const dir = tmp();
  try {
    writeFileSync(join(dir, "child.json"), JSON.stringify({
      tasks: [{ id: "scan", prompt: "x", provider: "ollama", model: "glm-4.6:cloud" }],
    }));
    const p = writeManifest(dir, { tasks: [{ id: "audit", manifest: "child.json" }] });
    const errs = errorsOf(() => loadManifest(p, CFG, dir));
    ok(errs.some((e) => e.includes("governance") && e.includes("glm-4.6:cloud")), errs.join("\n"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});


test("governance: a reader's cwd is root-gated like anything else, for Claude too", () => {
  const dir = tmp();
  const root = join(dir, "root");
  const inside = join(root, "sub");
  const outside = join(dir, "elsewhere");
  mkdirSync(inside, { recursive: true });
  mkdirSync(outside, { recursive: true });
  const cfg = { ...CFG, providers: { claude: { enabled: true, allowedRoots: [root] } } };
  try {
    const p1 = writeManifest(root, { tasks: [claudeTask({ cwd: outside })] });
    const errs = errorsOf(() => loadManifest(p1, cfg, root));
    ok(errs.some((e) => e.includes("allowedRoots")), errs.join("\n"));
    const p2 = writeManifest(root, { tasks: [claudeTask({ cwd: inside })] }, "in.json");
    equal(loadManifest(p2, cfg, root).tasks.length, 1);
    // No roots configured at all: the gate is inert rather than deny-everything.
    const p3 = writeManifest(dir, { tasks: [claudeTask({ cwd: outside })] }, "inert.json");
    equal(loadManifest(p3, CFG, dir).tasks.length, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});


test("governance: allowedRoots gates Claude too — the exemption is gone", () => {
  // RED: restore checkGovernance's `claude` early return and this passes validation.
  const dir = tmp();
  try {
    const cfg = { ...CFG, providers: { claude: { enabled: true, allowedRoots: ["C:/nowhere-at-all"] } } };
    const p = writeManifest(dir, { tasks: [claudeTask()] });
    ok(errorsOf(() => loadManifest(p, cfg, dir)).join("\n").match(/allowedRoots/));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ── allowedRoots: one top-level list, per-provider narrowing ──────────────────
// A top-level key states the common case once; a provider entry may only ever REMOVE a
// root from it. The widening half is what separates intersection from override, and an
// override implementation passes every other row in this section.

const ollamaTask = (over = {}) => ({ id: "o", prompt: "p", provider: "ollama", model: "minimax-m3:cloud", ...over });

test("governance: a top-level allowedRoots alone permits a provider with no entry of its own", () => {
  const repo = tmp();
  try {
    const p = writeManifest(repo, { tasks: [ollamaTask()] });
    const cfg = {
      ...CFG,
      allowedRoots: [repo],
      providers: { claude: { enabled: true }, ollama: { enabled: true } },
    };
    equal(loadManifest(p, cfg, repo).tasks[0].model, "minimax-m3:cloud");
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

// Narrowing cuts BOTH ways: a root the top level allows but the provider's own list omits
// is refused, and the refusal names the provider key — the only one that can fix it.
test("governance: a provider entry narrows the top-level list", () => {
  const repo = tmp();
  const narrow = join(repo, "narrow");
  const wide = join(repo, "wide");
  mkdirSync(narrow, { recursive: true });
  mkdirSync(wide, { recursive: true });
  try {
    const cfg = {
      ...CFG,
      allowedRoots: [repo],
      providers: { claude: { enabled: true }, ollama: { enabled: true, allowedRoots: [narrow] } },
    };
    const inside = writeManifest(narrow, { tasks: [ollamaTask()] }); // task cwd defaults to the manifest's dir
    equal(loadManifest(inside, cfg, narrow).tasks[0].model, "minimax-m3:cloud");

    const outside = writeManifest(narrow, { tasks: [ollamaTask({ cwd: wide })] }, "outside.json");
    const errs = errorsOf(() => loadManifest(outside, cfg, narrow));
    ok(errs.some((e) => e.includes("data governance") && e.includes("providers.ollama.allowedRoots")), errs.join("|"));
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

// Override returns the provider's own list here and dispatches; intersection returns the
// empty set and refuses. A root named only in a provider's list may never be granted.
test("governance: a provider entry cannot widen past the top-level list", () => {
  const repo = tmp();
  const elsewhere = tmp();
  try {
    const cfg = {
      ...CFG,
      allowedRoots: [repo],
      providers: { claude: { enabled: true }, ollama: { enabled: true, allowedRoots: [elsewhere] } },
    };
    const errs = errorsOf(() => loadManifest(writeManifest(elsewhere, { tasks: [ollamaTask()] }), cfg, elsewhere));
    ok(errs.some((e) => e.includes("data governance")), errs.join("|"));
  } finally {
    rmSync(repo, { recursive: true, force: true });
    rmSync(elsewhere, { recursive: true, force: true });
  }
});

// An explicit [] is the operator saying no. It keeps the data-governance wording and names
// the key that carries it — never the "unconfigured, run setup" route, which would tell a
// user who denied the root on purpose that they had never configured anything.
test("governance: an explicit [] at the top level denies, with the deliberate-denial wording", () => {
  const repo = tmp();
  try {
    const cfg = { ...CFG, allowedRoots: [], providers: { claude: { enabled: true }, ollama: { enabled: true } } };
    const msg = errorsOf(() => loadManifest(writeManifest(repo, { tasks: [ollamaTask()] }), cfg, repo)).join("|");
    ok(msg.includes("data governance"), msg);
    ok(msg.includes("allowedRoots"), msg);
    ok(!/has no .*allowedRoots configured/i.test(msg), "deliberate denial read as unconfigured: " + msg);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("governance: an explicit [] on the provider denies, naming the provider key", () => {
  const repo = tmp();
  try {
    const cfg = {
      ...CFG,
      allowedRoots: [repo],
      providers: { claude: { enabled: true }, ollama: { enabled: true, allowedRoots: [] } },
    };
    const msg = errorsOf(() => loadManifest(writeManifest(repo, { tasks: [ollamaTask()] }), cfg, repo)).join("|");
    ok(msg.includes("data governance") && msg.includes("providers.ollama.allowedRoots"), msg);
    ok(!/has no .*allowedRoots configured/i.test(msg), "deliberate denial read as unconfigured: " + msg);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

// The third unconfigured shape: no `providers` block at all. The already-landed rows cover
// a provider block that merely omits the key; this is the legacy-shaped config.
test("governance: a config with no providers block at all is unconfigured too", () => {
  const repo = tmp();
  try {
    const cfg = { ...CFG, providers: undefined };
    const msg = errorsOf(() => loadManifest(writeManifest(repo, { tasks: [claudeTask()] }), cfg, repo)).join("|");
    ok(msg.includes("/swarm:swarm setup"), "no setup route offered: " + msg);
    ok(/has no .*allowedRoots configured/i.test(msg), "not diagnosed as unconfigured: " + msg);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

// The shipped artifact, not a fixture: deny-by-default is a property of what users install.
// The shipped file gave ollama and codex `"allowedRoots": []` — a DELIBERATE denial nobody
// wrote, which under intersection permanently disarms any top-level list. Deleting those two
// entries is what moves this row from the deliberate-denial wording to the unconfigured one.
test("governance: the SHIPPED default config leaves ollama and codex unconfigured, not denied", () => {
  const repo = tmp();
  try {
    const shipped = JSON.parse(readFileSync(new URL("../config.default.json", import.meta.url), "utf8"));
    // Both cases enable their provider: the shipped default is opt-in, and
    // enabled:false only gates DISPATCH — the branch under test is the roots one.
    const on = (id) => ({ ...shipped, providers: { ...shipped.providers, [id]: { ...shipped.providers[id], enabled: true } } });
    const cases = [
      ["ollama", "minimax-m3:cloud", on("ollama")],
      // enabled:false only gates dispatch; the branch under test is the roots one.
      ["codex", "gpt-5-codex", { ...shipped, providers: { ...shipped.providers, codex: { ...shipped.providers.codex, enabled: true } } }],
    ];
    for (const [provider, model, cfg] of cases) {
      const msg = errorsOf(() => loadManifest(writeManifest(repo, { tasks: [ollamaTask({ provider, model })] }), cfg, repo)).join("|");
      ok(msg.includes("/swarm:swarm setup"), `${provider}: no setup route: ${msg}`);
      ok(/has no .*allowedRoots configured/i.test(msg), `${provider}: not the unconfigured wording: ${msg}`);
      ok(!msg.includes("data governance"), `${provider}: a list the user never wrote read as a deliberate denial: ${msg}`);
    }
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

// The compatibility floor: every config already in the wild carries only per-provider keys.
test("governance: a legacy config with only per-provider keys dispatches unchanged", () => {
  const repo = tmp();
  const elsewhere = tmp();
  try {
    const cfg = { ...CFG, providers: undefined, provider: { allowedRoots: [repo] } };
    equal(loadManifest(writeManifest(repo, { tasks: [ollamaTask()] }), cfg, repo).tasks[0].model, "minimax-m3:cloud");

    const msg = errorsOf(() => loadManifest(writeManifest(elsewhere, { tasks: [ollamaTask()] }), cfg, elsewhere)).join("|");
    ok(msg.includes("provider.allowedRoots"), msg);
  } finally {
    rmSync(repo, { recursive: true, force: true });
    rmSync(elsewhere, { recursive: true, force: true });
  }
});

// The run-level gate unions the seated providers' roots, so it must read the top level too —
// and name it, since a fix applied to a provider key the operator has not written does nothing.
test("governance: the run-level gate is bounded by a top-level list and names that key", () => {
  const repo = tmp();
  const elsewhere = tmp();
  try {
    const cfg = { ...CFG, allowedRoots: [elsewhere], providers: { claude: { enabled: true } } };
    const msg = errorsOf(() => loadManifest(writeManifest(repo, { tasks: [claudeTask()] }), cfg, repo)).join("|");
    ok(msg.includes(`this run's repo '${repo}'`), msg);
    ok(msg.includes("allowedRoots"), msg);
    ok(!msg.includes("providers.claude.allowedRoots"), "sent the operator to a key with no effect: " + msg);
  } finally {
    rmSync(repo, { recursive: true, force: true });
    rmSync(elsewhere, { recursive: true, force: true });
  }
});
