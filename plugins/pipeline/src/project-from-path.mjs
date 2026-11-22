import { execFileSync } from "node:child_process";

const WIN = process.platform === "win32";

// Inherited GIT_DIR & co. (e.g. when run from a git hook) would override `-C`-style discovery.
const STRIPPED_ENV = /^GIT_(DIR|WORK_TREE|INDEX_FILE|COMMON_DIR)$/;

function defaultGit(args, cwd) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !STRIPPED_ENV.test(k)));
  return execFileSync("git", args, {
    cwd,
    env,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
}

// Slash-normalised, trailing-slash-free; the form returned to callers.
function slashed(p) {
  const s = String(p).trim().replace(/\\/g, "/");
  return s.length > 1 ? s.replace(/\/+$/, "") : s;
}

// Comparison key: case is folded on win32 only, where the filesystem ignores it.
function key(p) {
  const s = slashed(p);
  return WIN ? s.toLowerCase() : s;
}

function basename(p) {
  return p.slice(p.lastIndexOf("/") + 1);
}

/**
 * Map any directory inside a git working tree (main checkout or linked worktree) to its
 * registered project. `rows` is the enabled-projects list as `{ name, root_path }`.
 *
 * Throws when `dir` is not inside a git working tree (including a bare repo's git dir).
 */
export function resolveProjectFromPath(dir, { rows = [], _git = defaultGit } = {}) {
  let worktreeRoot;
  let commonDir;
  try {
    worktreeRoot = slashed(_git(["rev-parse", "--show-toplevel"], dir));
    commonDir = slashed(_git(["rev-parse", "--path-format=absolute", "--git-common-dir"], dir));
  } catch (err) {
    throw new Error(`not inside a git working tree: ${dir} (${err.message.split("\n")[0]})`);
  }

  // The common dir of a linked worktree is the main checkout's `.git`; any other shape
  // (bare layout, submodule gitdir) leaves the toplevel as the only candidate root.
  const mainRoot = commonDir.endsWith("/.git") ? commonDir.slice(0, -"/.git".length) : null;

  const find = (root) => root != null && rows.find((r) => key(r.root_path) === key(root));
  const viaMain = find(mainRoot);
  const row = viaMain || find(worktreeRoot);
  const projectRoot = row && !viaMain ? worktreeRoot : (mainRoot ?? worktreeRoot);

  return {
    project: row ? row.name : basename(projectRoot),
    projectRoot,
    worktreeRoot,
    registered: Boolean(row),
  };
}
