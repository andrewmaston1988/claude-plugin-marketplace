// resolveProjectFromPath: worktree path -> registered project via git's common dir.
import "./helpers/isolate-home.mjs";
import { test } from "node:test";
import { deepEqual, equal, throws } from "node:assert/strict";
import { mkdtempSync, mkdirSync, realpathSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { resolveProjectFromPath } from "../src/project-from-path.mjs";

const WIN = process.platform === "win32";
const norm = (p) => {
  const s = p.replace(/\\/g, "/");
  return WIN ? s.toLowerCase() : s;
};

// Fake git: maps the rev-parse flag to a canned answer; records the cwd it was asked in.
function fakeGit({ toplevel, common }) {
  const calls = [];
  const fn = (args, cwd) => {
    calls.push({ args, cwd });
    if (args.includes("--show-toplevel")) {
      if (toplevel == null) throw new Error("not a git repository");
      return toplevel;
    }
    if (args.includes("--git-common-dir")) {
      if (common == null) throw new Error("not a git repository");
      return common;
    }
    throw new Error(`unexpected git call: ${args.join(" ")}`);
  };
  fn.calls = calls;
  return fn;
}

test("linked worktree resolves to the registered project and its main root", () => {
  const _git = fakeGit({ toplevel: "/w/.worktrees/proj/feat", common: "/w/proj/.git" });
  const rows = [{ name: "proj", root_path: "/w/proj" }];
  deepEqual(resolveProjectFromPath("/w/.worktrees/proj/feat", { rows, _git }), {
    project: "proj",
    projectRoot: "/w/proj",
    worktreeRoot: "/w/.worktrees/proj/feat",
    registered: true,
  });
});

test("main checkout resolves to the same project, root equal to worktreeRoot", () => {
  const _git = fakeGit({ toplevel: "/w/proj", common: "/w/proj/.git" });
  const rows = [{ name: "proj", root_path: "/w/proj" }];
  const r = resolveProjectFromPath("/w/proj", { rows, _git });
  equal(r.project, "proj");
  equal(r.projectRoot, "/w/proj");
  equal(r.worktreeRoot, "/w/proj");
  equal(r.registered, true);
});

test("the project name comes from the row, not the folder", () => {
  const _git = fakeGit({ toplevel: "/w/folder-name", common: "/w/folder-name/.git" });
  const rows = [{ name: "registered-name", root_path: "/w/folder-name" }];
  equal(resolveProjectFromPath("/w/folder-name", { rows, _git }).project, "registered-name");
});

test("git is asked from the dir the caller passed", () => {
  const _git = fakeGit({ toplevel: "/w/proj", common: "/w/proj/.git" });
  resolveProjectFromPath("/w/proj/sub/dir", { rows: [], _git });
  for (const c of _git.calls) equal(c.cwd, "/w/proj/sub/dir");
});

test("an unregistered repo returns registered:false with the main root's basename", () => {
  const _git = fakeGit({ toplevel: "/w/.worktrees/other/feat", common: "/w/other/.git" });
  const rows = [{ name: "proj", root_path: "/w/proj" }];
  deepEqual(resolveProjectFromPath("/w/.worktrees/other/feat", { rows, _git }), {
    project: "other",
    projectRoot: "/w/other",
    worktreeRoot: "/w/.worktrees/other/feat",
    registered: false,
  });
});

test("missing rows is treated as no registered projects", () => {
  const _git = fakeGit({ toplevel: "/w/proj", common: "/w/proj/.git" });
  const r = resolveProjectFromPath("/w/proj", { _git });
  equal(r.registered, false);
  equal(r.project, "proj");
});

test("a registered root_path that is itself a linked worktree matches via show-toplevel", () => {
  const _git = fakeGit({ toplevel: "/w/reg-wt", common: "/w/main/.git" });
  const rows = [{ name: "reg", root_path: "/w/reg-wt" }];
  deepEqual(resolveProjectFromPath("/w/reg-wt", { rows, _git }), {
    project: "reg",
    projectRoot: "/w/reg-wt",
    worktreeRoot: "/w/reg-wt",
    registered: true,
  });
});

test("a common dir not ending in /.git (bare layout) falls back to show-toplevel", () => {
  const _git = fakeGit({ toplevel: "/w/bare/feat", common: "/w/bare/.bare" });
  const rows = [{ name: "bare-proj", root_path: "/w/bare/feat" }];
  const r = resolveProjectFromPath("/w/bare/feat", { rows, _git });
  equal(r.project, "bare-proj");
  equal(r.projectRoot, "/w/bare/feat");
  equal(r.registered, true);
});

test("the main-root match beats a show-toplevel match", () => {
  const _git = fakeGit({ toplevel: "/w/wt", common: "/w/main/.git" });
  const rows = [
    { name: "via-worktree", root_path: "/w/wt" },
    { name: "via-main", root_path: "/w/main" },
  ];
  equal(resolveProjectFromPath("/w/wt", { rows, _git }).project, "via-main");
});

test("backslashes and a trailing slash in root_path still match", () => {
  const _git = fakeGit({ toplevel: "C:/x/Repo", common: "C:/x/Repo/.git" });
  for (const root_path of ["C:\\x\\Repo", "C:/x/Repo/", "C:\\x\\Repo\\"]) {
    const r = resolveProjectFromPath("C:/x/Repo", { rows: [{ name: "repo", root_path }], _git });
    equal(r.registered, true, root_path);
  }
});

test("backslash git output is normalised to forward slashes", () => {
  const _git = fakeGit({ toplevel: "C:\\x\\wt", common: "C:\\x\\Repo\\.git" });
  const r = resolveProjectFromPath("C:\\x\\wt", { rows: [{ name: "repo", root_path: "C:/x/Repo" }], _git });
  equal(r.projectRoot, "C:/x/Repo");
  equal(r.worktreeRoot, "C:/x/wt");
  equal(r.registered, true);
});

test("win32: C:\\x\\Repo, C:/x/Repo/ and c:/x/repo all match one row", { skip: !WIN }, () => {
  const _git = fakeGit({ toplevel: "C:/x/Repo", common: "C:/x/Repo/.git" });
  for (const root_path of ["C:\\x\\Repo", "C:/x/Repo/", "c:/x/repo"]) {
    equal(resolveProjectFromPath("C:/x/Repo", { rows: [{ name: "repo", root_path }], _git }).registered, true, root_path);
  }
  const _git2 = fakeGit({ toplevel: "c:/x/repo", common: "c:/x/repo/.git" });
  equal(resolveProjectFromPath("c:/x/repo", { rows: [{ name: "repo", root_path: "C:\\x\\Repo" }], _git: _git2 }).registered, true);
});

test("off win32, paths differing only in case are different projects", { skip: WIN }, () => {
  const _git = fakeGit({ toplevel: "/x/Repo", common: "/x/Repo/.git" });
  equal(resolveProjectFromPath("/x/Repo", { rows: [{ name: "repo", root_path: "/x/repo" }], _git }).registered, false);
});

test("a directory outside any git working tree throws", () => {
  const _git = fakeGit({ toplevel: null, common: null });
  throws(() => resolveProjectFromPath("/nowhere", { rows: [], _git }), /git/i);
});

// --- real git ---

const GIT_ENV = Object.fromEntries(
  Object.entries(process.env).filter(([k]) => !/^GIT_(DIR|WORK_TREE|INDEX_FILE|COMMON_DIR)$/.test(k)),
);
const git = (cwd, ...args) =>
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", ...args], {
    cwd,
    env: GIT_ENV,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();

function makeRepo() {
  const tmp = realpathSync.native(mkdtempSync(join(tmpdir(), "pfp-")));
  const main = join(tmp, "Main");
  mkdirSync(main);
  git(main, "init", "-q");
  git(main, "commit", "--allow-empty", "-q", "-m", "init");
  const wt = join(tmp, ".worktrees", "main", "feat");
  git(main, "worktree", "add", "-q", "-b", "feat", wt);
  return { tmp, main, wt };
}

test("real git: a linked worktree resolves to the registered project and main root", () => {
  const { tmp, main, wt } = makeRepo();
  try {
    const r = resolveProjectFromPath(wt, { rows: [{ name: "registered", root_path: main }] });
    equal(r.project, "registered");
    equal(norm(r.projectRoot), norm(main));
    equal(norm(r.worktreeRoot), norm(wt));
    equal(r.registered, true);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("real git: the main checkout resolves to the same project", () => {
  const { tmp, main } = makeRepo();
  try {
    const r = resolveProjectFromPath(main, { rows: [{ name: "registered", root_path: main }] });
    equal(r.project, "registered");
    equal(norm(r.projectRoot), norm(main));
    equal(norm(r.worktreeRoot), norm(main));
    equal(r.registered, true);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("real git: a subdirectory of a linked worktree resolves the same way", () => {
  const { tmp, main, wt } = makeRepo();
  try {
    const sub = join(wt, "a", "b");
    mkdirSync(sub, { recursive: true });
    const r = resolveProjectFromPath(sub, { rows: [{ name: "registered", root_path: main }] });
    equal(r.project, "registered");
    equal(norm(r.worktreeRoot), norm(wt));
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("real git: a registered root_path that is a linked worktree matches via show-toplevel", () => {
  const { tmp, main, wt } = makeRepo();
  try {
    const r = resolveProjectFromPath(wt, { rows: [{ name: "wt-registered", root_path: wt }] });
    equal(r.project, "wt-registered");
    equal(r.registered, true);
    equal(norm(r.projectRoot), norm(wt));
    // The main checkout is a different root, so it does not match that row.
    const m = resolveProjectFromPath(main, { rows: [{ name: "wt-registered", root_path: wt }] });
    equal(m.registered, false);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("real git: an unregistered repo returns registered:false with the main root's basename", () => {
  const { tmp, main, wt } = makeRepo();
  try {
    const r = resolveProjectFromPath(wt, { rows: [{ name: "other", root_path: join(tmp, "elsewhere") }] });
    equal(r.registered, false);
    equal(r.project, "Main");
    equal(norm(r.projectRoot), norm(main));
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("real git: a plain directory throws", () => {
  const tmp = realpathSync.native(mkdtempSync(join(tmpdir(), "pfp-plain-")));
  try {
    throws(() => resolveProjectFromPath(tmp, { rows: [] }), /git/i);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});
