// A tree under an out-of-home treeRoot must be judged by its source repo,
// while the allowedRoots gate continues to bind.
import { test } from "node:test";
import { equal, ok } from "node:assert/strict";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { loadManifest } from "./helpers/repo-io.mjs";
import { CFG, writeManifest, tmp, errorsOf } from "./helpers/manifest-fixtures.mjs";
import { cwdAllowed, defaultGovernanceIo } from "../src/governance.mjs";

const ollamaTask = (over = {}) => ({ id: "o", prompt: "p", provider: "ollama", model: "minimax-m3:cloud", ...over });

test("governance: defaultGovernanceIo carries the configured treeRoot, not just the swarm home", () => {
  const root = tmp();
  try {
    equal(defaultGovernanceIo({ treeRoot: root }).treeRoot, root,
      "a gate that cannot see treeRoot refuses every cwd under a tree root outside the home");
    ok(defaultGovernanceIo({}).treeRoot, "the default root is still a root, so the widening never disappears");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// The gate itself: the repo lookup is the only thing stubbed, so the io under test
// is the one the engine builds.
const govIo = (cfg, repo) => ({ ...defaultGovernanceIo(cfg), repoLookup: () => ({ repo }) });

test("governance: a tree under an out-of-home treeRoot is judged by the repo it was cut from", () => {
  const repo = tmp();
  const treeRoot = tmp();
  const wt = join(treeRoot, "C--code-repo", "run1", "impl");
  mkdirSync(wt, { recursive: true });
  try {
    const cfg = { ...CFG, treeRoot, providers: { ollama: { enabled: true, allowedRoots: [repo] } } };
    equal(cwdAllowed(wt, [repo], govIo(cfg, repo)).reason, "allowed",
      "the tree is outside home AND outside every root — only the scratch root can vouch for it");
  } finally {
    rmSync(repo, { recursive: true, force: true });
    rmSync(treeRoot, { recursive: true, force: true });
  }
});

test("governance: treeRoot widens nothing by itself — a tree of a repo outside the roots is still refused", () => {
  const repo = tmp();
  const stranger = tmp();
  const treeRoot = tmp();
  const wt = join(treeRoot, "C--code-repo", "run1", "impl");
  mkdirSync(wt, { recursive: true });
  try {
    const cfg = { ...CFG, treeRoot, providers: { ollama: { enabled: true, allowedRoots: [repo] } } };
    equal(cwdAllowed(wt, [repo], govIo(cfg, stranger)).reason, "outside-roots",
      "per-provider roots must still bind inside the scratch root, or treeRoot is a blanket allow");
  } finally {
    rmSync(repo, { recursive: true, force: true });
    rmSync(stranger, { recursive: true, force: true });
    rmSync(treeRoot, { recursive: true, force: true });
  }
});

test("governance: a tree cwd under an out-of-home treeRoot passes the manifest gate", () => {
  const repo = tmp();
  const treeRoot = tmp();
  const wt = join(treeRoot, "C--code-repo", "run1", "impl");
  mkdirSync(wt, { recursive: true });
  try {
    const cfg = { ...CFG, treeRoot, providers: { ollama: { enabled: true, allowedRoots: [repo] } } };
    const p = writeManifest(repo, { tasks: [ollamaTask({ cwd: wt })] });
    const io = { treeRoot, repoToplevel: () => repo, repoLookup: () => ({ repo }) };
    equal(loadManifest(p, cfg, repo, { io }).tasks[0].cwd, wt);

    // The same run without the root threaded is the refusal this test exists to
    // catch: the io carries `home`, which an out-of-home tree is not under.
    const errs = errorsOf(() => loadManifest(p, cfg, repo, {
      io: { treeRoot: undefined, repoToplevel: () => repo, repoLookup: () => ({ repo }) },
    }));
    ok(errs.some((e) => e.includes("data governance") && e.includes(wt)), errs.join("|"));
  } finally {
    rmSync(repo, { recursive: true, force: true });
    rmSync(treeRoot, { recursive: true, force: true });
  }
});
