// Run home: the results directory is keyed on the repo toplevel, so a dispatch
// from any subdirectory resumes the same run — while a non-repo, or a repo
// outside allowedRoots, is refused.
import { test } from "node:test";
import { equal, ok } from "node:assert/strict";
import { writeFileSync, rmSync, mkdirSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { realRepoToplevel } from "../src/manifest.mjs";
import { loadManifest } from "./helpers/repo-io.mjs";
import { CFG, writeManifest, tmp, errorsOf, claudeTask } from "./helpers/manifest-fixtures.mjs";

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
