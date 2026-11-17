import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";

const templates = new Map();

function isPlainRepo(repo) {
  const gitDir = join(repo, ".git");
  if (!existsSync(gitDir) || !statSync(gitDir).isDirectory()) return false;
  const result = spawnSync("git", ["worktree", "list", "--porcelain"], { cwd: repo, encoding: "utf8", windowsHide: true });
  return result.status === 0 && (result.stdout.match(/^worktree /gm) || []).length === 1;
}

export function templateRepo(shape, build) {
  let template = templates.get(shape);
  if (!template) {
    const home = process.env.SWARM_HOME || tmpdir();
    const root = join(home, "swarm-template-repos");
    mkdirSync(root, { recursive: true });
    template = mkdtempSync(join(root, `${shape}-`));
    try {
      build(template);
      if (!isPlainRepo(template)) throw new Error(`template repo shape must be a plain repository: ${shape}`);
      templates.set(shape, template);
    } catch (error) {
      rmSync(template, { recursive: true, force: true });
      throw error;
    }
  }
  const copy = mkdtempSync(join(tmpdir(), `swarm-${shape}-`));
  cpSync(template, copy, { recursive: true, preserveTimestamps: true });
  return copy;
}
