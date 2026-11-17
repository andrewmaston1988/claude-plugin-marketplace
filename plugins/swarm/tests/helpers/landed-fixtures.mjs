// Fixture builders for landed.test.mjs rows whose setup dominates that file's
// runtime. Each builds its state in as few git processes as its assertion allows.
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";

function run(args, cwd, input) {
  const r = spawnSync("git", args, { cwd, encoding: "utf8", windowsHide: true, input });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${(r.stderr || "").trim()}`);
  return (r.stdout || "").trim();
}

// One `git commit` per commit pays a git start plus whatever the global hooks do;
// one fast-import stream writes the same linear history. The first commit branches
// from HEAD, the rest chain onto the branch the stream already holds.
export function importTouchingCommits(repo, { path, count }) {
  const branch = run(["symbolic-ref", "--short", "HEAD"], repo);
  const from = run(["rev-parse", "HEAD"], repo);
  const stamp = 1700000000;
  let stream = "";
  for (let i = 0; i < count; i += 1) {
    const body = `later ${i}\n`;
    stream += `commit refs/heads/${branch}\n`
      + `mark :${i + 1}\n`
      + `author Landed Fixture <fixture@example.invalid> ${stamp + i} +0000\n`
      + `committer Landed Fixture <fixture@example.invalid> ${stamp + i} +0000\n`
      + `data ${Buffer.byteLength(body)}\n${body}`
      + (i === 0 ? `from ${from}\n` : "")
      + `M 100644 inline ${path}\ndata ${Buffer.byteLength(body)}\n${body}`;
  }
  run(["fast-import", "--quiet", "--done"], repo, `${stream}done\n`);
}

// Long enough that a few hundred of these names exceed a Windows command line.
export const argvOverflowName = (i) =>
  `a/${String(i).padStart(4, "0")}-a-name-long-enough-to-overflow-a-command-line.txt`;

export function argvOverflowPaths(count) {
  return Array.from({ length: count }, (_, i) => argvOverflowName(i + 1));
}

// Writes every path on the current branch and commits them all as one commit.
export function commitPaths(repo, paths, message) {
  for (const dir of new Set(paths.map((p) => dirname(p)))) mkdirSync(join(repo, dir), { recursive: true });
  paths.forEach((p, i) => writeFileSync(join(repo, p), `file ${i + 1}\n`));
  run(["add", "."], repo);
  run(["commit", "-qm", message], repo);
}
