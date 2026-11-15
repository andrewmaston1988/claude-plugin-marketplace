// WSL mode: mirror the working tree onto plugin-dev's ext4 disk, then run the
// suite there. Linux-only failures surface before the PR instead of in CI.

// The mirror is a git clone of the repository's COMMON dir (`--git-common-dir`,
// so a linked worktree works) plus an rsync of the tree that is running now.
// /mnt/c reports every file as mode 777, so the rsync copies no permissions
// (-rlt, never -a) and the clone keeps git's own modes; with `-a` every file
// reads as mode-dirty in the mirror.

// Every wsl.exe call is an argument array with no shell: wsl.exe re-quotes a
// single command string, which mangles it.

// Exit codes: the suite's own code, or 2 when WSL mode could not run at all.

export const DISTRO = "plugin-dev";

export const SETUP_POINTER = `[wsl] the WSL distro "${DISTRO}" is not installed.

  Set it up first -- TESTING.md, section "The plugin-dev distro", has the
  commands (Ubuntu 26.04 with node, git, rsync and Google Chrome). Then check:

      wsl.exe -l -q
`;

/** `C:\a\b` and `C:/a/b` -> `/mnt/c/a/b`. Anything already POSIX comes back
 *  as written, so a Linux path survives a round trip. */
export function toWslPath(winPath) {
  const path = String(winPath).replace(/\\/g, "/");
  const drive = /^([A-Za-z]):(\/|$)/.exec(path);
  if (!drive) return path;
  return `/mnt/${drive[1].toLowerCase()}${path.slice(2) || "/"}`;
}

/** `wsl.exe -l -q` prints UTF-16LE on Windows and has printed UTF-8 on older
 *  builds. A NUL in every odd byte is the tell (a leading BOM is the other),
 *  so detect rather than assume. */
export function distroList(buf) {
  const bytes = Buffer.isBuffer(buf) ? buf : Buffer.from(String(buf ?? ""), "utf8");
  return bytes
    .toString(isUtf16Le(bytes) ? "utf16le" : "utf8")
    .replace(/\uFEFF/g, "")
    .split(/\r?\n/)
    .map((line) => line.replace(/\u0000/g, "").trim())
    .filter(Boolean);
}

function isUtf16Le(bytes) {
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) return true;
  const probe = Math.min(bytes.length, 64);
  if (probe < 2) return false;
  for (let i = 1; i < probe; i += 2) if (bytes[i] !== 0) return false;
  return true;
}

function text(value) {
  if (Buffer.isBuffer(value)) return value.toString("utf8");
  return String(value ?? "");
}

function isAbsolutePath(path) {
  return /^[A-Za-z]:[\\/]/.test(path) || /^[\\/]/.test(path);
}

/** `--git-common-dir` prints an absolute path from a linked worktree and a
 *  bare `.git` from the main checkout; both name the same directory. */
function commonDirOf(commonDir, repoRoot) {
  if (isAbsolutePath(commonDir)) return commonDir;
  return `${String(repoRoot).replace(/[\\/]+$/, "")}/${commonDir}`;
}

/** `.../<repo>/.git` -> `<repo>`, which is the mirror's name. */
function repoNameOf(commonDir) {
  const parts = String(commonDir).replace(/[\\/]+$/, "").split(/[\\/]/);
  if (parts[parts.length - 1] === ".git") parts.pop();
  return parts[parts.length - 1] || "repo";
}

/**
 * Sync the mirror and run `command` (an argv array) inside it.
 *
 * @param {object}   options
 * @param {string}   options.repoRoot  the tree to mirror, and the local git cwd
 * @param {string[]} options.command   argv run in the mirror, e.g. `["node","scripts/test.mjs","--all"]`
 * @param {Function} options._spawnSync node's `spawnSync`, injected for tests
 * @param {object}   options._fs       node's `fs`, injected for tests
 * @param {Function} options.log       progress printer, one line per call
 * @returns {Promise<number>} the command's exit code, or 2 when it never ran
 */
export async function runWsl({ repoRoot, command, _spawnSync, _fs, log }) {
  const wsl = (argv, opts = {}) => {
    const r = _spawnSync("wsl.exe", argv, { encoding: "buffer", ...opts });
    return {
      status: r && typeof r.status === "number" ? r.status : 1,
      stdout: Buffer.isBuffer(r?.stdout) ? r.stdout : Buffer.from(text(r?.stdout), "utf8"),
      stderr: text(r?.stderr),
    };
  };
  const local = (args) => {
    const r = _spawnSync("git", args, { cwd: repoRoot, encoding: "utf8" });
    return {
      status: r && typeof r.status === "number" ? r.status : 1,
      stdout: text(r?.stdout),
      stderr: text(r?.stderr),
    };
  };
  const inDistro = (...argv) => ["-d", DISTRO, "--", ...argv];
  const at = (dir, ...argv) => ["-d", DISTRO, "--cd", dir, "--", ...argv];
  const run = (label, argv) => {
    const r = wsl(argv);
    if (r.status !== 0) {
      process.stderr.write(`[wsl] ${label} failed (exit ${r.status})\n${r.stderr.trim()}\n`);
    }
    return r.status;
  };

  if (!distroList(wsl(["-l", "-q"]).stdout).includes(DISTRO)) {
    process.stderr.write(SETUP_POINTER);
    return 2;
  }
  if (!_fs.existsSync(repoRoot)) {
    process.stderr.write(`[wsl] repository root not found: ${repoRoot}\n`);
    return 2;
  }

  const head = local(["rev-parse", "HEAD"]);
  const common = local(["rev-parse", "--git-common-dir"]);
  if (head.status !== 0 || common.status !== 0) {
    process.stderr.write(`[wsl] cannot read the repository at ${repoRoot}\n`);
    return 2;
  }
  const sourceUrl = toWslPath(commonDirOf(common.stdout.trim(), repoRoot));
  const name = repoNameOf(sourceUrl);

  const homeResult = wsl(inDistro("printenv", "HOME"));
  const home = text(homeResult.stdout).trim();
  if (homeResult.status !== 0 || home === "") {
    process.stderr.write(`[wsl] cannot read the home directory in ${DISTRO}\n`);
    return 2;
  }
  const mirror = `${home.replace(/\/+$/, "")}/mirror/${name}`;

  // A mirror holding some other checkout would fetch from the wrong remote and
  // never see a local commit. Nothing in a mirror is worth keeping, so replace
  // it rather than fail.
  const origin = wsl(at(mirror, "git", "config", "--get", "remote.origin.url"));
  if (!(origin.status === 0 && text(origin.stdout).trim() === sourceUrl)) {
    if (
      run(`mkdir -p ${home}/mirror`, inDistro("mkdir", "-p", `${home.replace(/\/+$/, "")}/mirror`)) !== 0
    ) {
      return 2;
    }
    if (wsl(inDistro("test", "-d", mirror)).status === 0) {
      log(`wsl: replacing ${mirror}: not a clone of ${sourceUrl}`);
      if (run(`removing ${mirror}`, inDistro("rm", "-rf", mirror)) !== 0) return 2;
    }
    log(`wsl: cloning ${sourceUrl} -> ${mirror} (first sync)`);
    if (run("git clone", inDistro("git", "clone", "--quiet", sourceUrl, mirror)) !== 0) return 2;
    if (run("core.fileMode false", at(mirror, "git", "config", "core.fileMode", "false")) !== 0) {
      return 2;
    }
  }

  const sha = head.stdout.trim();
  log(`wsl: syncing ${repoRoot} -> ${mirror} at ${sha.slice(0, 8)}`);
  if (run("git fetch", at(mirror, "git", "fetch", "--quiet", "origin")) !== 0) return 2;
  // Forced: the last sync's rsync left tracked files dirty, and a plain
  // checkout then refuses to move HEAD. The mirror holds nothing of its own.
  if (run("git checkout", at(mirror, "git", "checkout", "--force", "--detach", sha)) !== 0) return 2;
  const source = `${toWslPath(repoRoot).replace(/\/+$/, "")}/`;
  const rsync = [
    "rsync",
    "-rlt",
    "--delete",
    "--exclude",
    ".git",
    "--exclude",
    "node_modules",
    source,
    `${mirror}/`,
  ];
  if (run("rsync", inDistro(...rsync)) !== 0) return 2;

  log(`wsl: running ${command.join(" ")} in ${mirror}`);
  const r = _spawnSync("wsl.exe", at(mirror, ...command), { stdio: "inherit" });
  return r && typeof r.status === "number" ? r.status : 1;
}
