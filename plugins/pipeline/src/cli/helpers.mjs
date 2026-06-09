import { spawnSync } from "node:child_process";

export function getFlag(name, argv) {
  const i = argv.indexOf(name);
  return i !== -1 && i + 1 < argv.length ? argv[i + 1] : null;
}

// Detect the repo's default branch for the given working directory.
// Order: remote HEAD → git config init.defaultBranch → "master".
export function detectDefaultBranch(cwd) {
  const rHead = spawnSync("git", ["symbolic-ref", "refs/remotes/origin/HEAD"],
    { cwd, stdio: ["ignore", "pipe", "pipe"] });
  if (rHead.status === 0) {
    const m = rHead.stdout.toString().trim().match(/refs\/remotes\/origin\/(.+)/);
    if (m) return m[1];
  }
  const rCfg = spawnSync("git", ["config", "init.defaultBranch"],
    { cwd, stdio: ["ignore", "pipe", "pipe"] });
  if (rCfg.status === 0) {
    const b = rCfg.stdout.toString().trim();
    if (b) return b;
  }
  return "master";
}
