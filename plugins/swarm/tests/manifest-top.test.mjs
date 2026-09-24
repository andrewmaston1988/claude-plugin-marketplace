import "./helpers/isolate-home.mjs";
import { test } from "node:test";
import { equal, ok } from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { loadManifest } from "../src/manifest.mjs";
import { runPlan } from "../src/scheduler.mjs";
import { CFG, writeManifest, tmp, errorsOf } from "./helpers/manifest-fixtures.mjs";
import { fakeSpawnFactory, makeIo } from "./helpers/fake-io.mjs";

Object.assign(process.env, { GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "core.hooksPath", GIT_CONFIG_VALUE_0: "/dev/null" });

const git = (args, cwd) =>
  spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", ...args],
    { cwd, encoding: "utf8", windowsHide: true }).stdout.trim();

function repo(dir, file) {
  mkdirSync(dir, { recursive: true });
  git(["init", "-q", "-b", "main"], dir);
  writeFileSync(join(dir, file), "x\n");
  git(["add", "."], dir);
  git(["commit", "-q", "-m", file], dir);
  return git(["rev-parse", "HEAD"], dir);
}

const LEAF = { provider: "claude", model: "claude-haiku-4-5-20251001" };

// Dispatched from repo A, a manifest naming repo B must run its tasks in B.
test("a top-level cwd is every task's default cwd, and a writer's tree is cut from its HEAD", async () => {
  const root = tmp();
  try {
    repo(join(root, "a"), "a.txt");
    const bHead = repo(join(root, "b"), "b.txt");
    const p = writeManifest(root, { cwd: join(root, "b"), tasks: [
      { id: "impl", prompt: "p", ...LEAF, allowedTools: "Read,Bash" },
      { id: "read", prompt: "p", ...LEAF, cwd: "." },
    ] });
    const plan = loadManifest(p, CFG, join(root, "a"));
    equal(plan.tasks.find((t) => t.id === "read").cwd, resolve(root, "b"), "a task's own relative cwd resolves against the top-level cwd");
    const heads = [];
    await runPlan(plan, CFG, makeIo(fakeSpawnFactory((call) => {
      if (call.opts.cwd.includes("wt-impl")) heads.push(git(["rev-parse", "HEAD"], call.opts.cwd));
      return {};
    })));
    equal(heads[0], bHead, "the writer's tree is cut from the top-level cwd's repo");
  } finally {
    spawnSync("git", ["worktree", "prune"], { cwd: join(root, "b"), windowsHide: true });
    rmSync(root, { recursive: true, force: true });
  }
});

test("a top-level cwd that is not a non-empty string is refused", () => {
  const dir = tmp();
  try {
    repo(dir, "a.txt");
    const p = writeManifest(dir, { cwd: 3, tasks: [{ id: "a", prompt: "p", ...LEAF }] });
    const errs = errorsOf(() => loadManifest(p, CFG, dir));
    ok(errs.some((e) => e.startsWith("cwd must be")), errs.join("\n"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("an unknown top-level key is refused, naming the keys a manifest takes", () => {
  const dir = tmp();
  try {
    repo(dir, "a.txt");
    const p = writeManifest(dir, { workdir: "x", tasks: [{ id: "a", prompt: "p", ...LEAF }] });
    const errs = errorsOf(() => loadManifest(p, CFG, dir));
    ok(errs.some((e) => e.includes("'workdir'") && e.includes("cwd")), errs.join("\n"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a top-level description is accepted as free text", () => {
  const dir = tmp();
  try {
    repo(dir, "a.txt");
    const p = writeManifest(dir, { description: "why this run exists", tasks: [{ id: "a", prompt: "p", ...LEAF }] });
    equal(loadManifest(p, CFG, dir).tasks.length, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a child manifest may not set cwd or an unknown key — the parent owns the run", () => {
  const dir = tmp();
  try {
    repo(dir, "a.txt");
    writeFileSync(join(dir, "child.json"), JSON.stringify({ cwd: dir, workdir: "x", tasks: [{ id: "c", prompt: "p", ...LEAF }] }));
    const p = writeManifest(dir, { tasks: [{ id: "audit", manifest: "child.json" }] });
    const errs = errorsOf(() => loadManifest(p, CFG, dir));
    ok(errs.some((e) => e.includes("may not set cwd") && e.includes("parent owns the run")), errs.join("\n"));
    ok(errs.some((e) => e.includes("child manifest") && e.includes("'workdir'")), errs.join("\n"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
