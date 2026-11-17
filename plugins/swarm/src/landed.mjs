// "Landed" means destroying this branch loses nothing: a ref outside the swarm prefix
// holds its tip, or a base already absorbs it. An unreadable git answer is Infinity.

const TIMEOUT = 60000;
const TOUCHING_SCAN_CAP = 20;
const MERGE_TREE_MIN_VERSION = [2, 38];
const MERGE_TREE_BATCH_VERSION = [2, 39];

export function gitOf(gitRunner, args, repo, opts = {}) {
  return gitRunner(args, repo, { timeout: TIMEOUT, ...opts });
}

// Windows caps a command line near 32k characters, so a repo-wide rename would overflow
// it and read as Infinity. Path lists travel on stdin, or the pathspec in budgeted chunks.
const ARGV_PATH_BUDGET = 8000;

function pathChunks(paths) {
  const chunks = [];
  let cur = [];
  let used = 0;
  for (const path of paths) {
    if (cur.length && used + path.length + 1 > ARGV_PATH_BUDGET) {
      chunks.push(cur);
      cur = [];
      used = 0;
    }
    cur.push(path);
    used += path.length + 1;
  }
  if (cur.length) chunks.push(cur);
  return chunks;
}

function fail(what, r) {
  throw new Error(`git ${what} failed (${r.status}): ${r.stderr}`);
}

function lines(text) {
  return text.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
}

// Swarm branches are a dispatch mechanism, never a landing place — including a
// remote copy, whose `origin/swarm/...` short form a bare startsWith would miss.
export function isSwarmRef(refname, prefix) {
  const bare = String(refname)
    .replace(/^refs\/heads\//, "")
    .replace(/^refs\/remotes\/[^/]+\//, "");
  return bare.startsWith(prefix);
}

// A remote's HEAD is the name git records for a repo's default branch, and a clone's
// remote need not be called `origin`. No remote HEAD names none.
export function defaultBranch(gitRunner, repo) {
  const heads = gitOf(gitRunner, ["for-each-ref", "--format=%(refname) %(symref)", "refs/remotes"], repo);
  if (heads.status !== 0 || !heads.stdout) return null;
  for (const line of heads.stdout.split(/\r?\n/)) {
    const [ref, target] = line.trim().split(/\s+/);
    const m = /^refs\/remotes\/([^/]+)\/(.+)$/.exec(target || "");
    if (ref?.endsWith("/HEAD") && m) return { remote: m[1], name: m[2] };
  }
  return null;
}

export const defaultBranchName = (gitRunner, repo) => defaultBranch(gitRunner, repo)?.name ?? null;

// The default branch as this repo sees it: the local branch of that name where it
// exists, then the remote-tracking copy. Never the checkout — during a port that is
// the branch the caller is asking about.
export function defaultCommits(repo, gitRunner) {
  const found = defaultBranch(gitRunner, repo);
  if (!found) return [];
  const commits = [];
  for (const ref of [`refs/heads/${found.name}`, `refs/remotes/${found.remote}/${found.name}`]) {
    const r = gitOf(gitRunner, ["rev-parse", "--verify", `${ref}^{commit}`], repo);
    if (r.status === 0 && r.stdout && !commits.includes(r.stdout)) commits.push(r.stdout);
  }
  return commits;
}

// The default branch and the checked-out branch: where work lands. Remote refs
// are not scanned — merge-tree across every ref costs seconds per branch. The default
// branch comes from the same any-remote HEAD rule the taken check uses, so the two
// cannot disagree on a clone whose remote is not `origin`.
export function candidateBases(repo, prefix, gitRunner) {
  const refs = [];
  const found = defaultBranch(gitRunner, repo);
  if (found) {
    refs.push(`refs/remotes/${found.remote}/${found.name}`);
    refs.push(`refs/heads/${found.name}`);
  }
  const head = gitOf(gitRunner, ["symbolic-ref", "-q", "HEAD"], repo);
  let detached = null;
  if (head.status === 0 && head.stdout) refs.push(head.stdout);
  else {
    const sha = gitOf(gitRunner, ["rev-parse", "HEAD"], repo);
    if (sha.status !== 0 || !sha.stdout) fail("rev-parse HEAD", sha);
    detached = sha.stdout;
  }

  const bases = [];
  const seen = new Set();
  for (const ref of refs) {
    if (isSwarmRef(ref, prefix)) continue;
    const r = gitOf(gitRunner, ["rev-parse", "--verify", `${ref}^{commit}`], repo);
    if (r.status !== 0 || !r.stdout) continue;
    if (seen.has(r.stdout)) continue;
    seen.add(r.stdout);
    bases.push(r.stdout);
  }
  if (detached && !seen.has(detached)) bases.push(detached);
  return bases;
}

// True when any ref outside the swarm prefix contains the branch tip. The
// branch's own local ref does not count; a pushed copy under another name does.
export function reachable(branch, repo, prefix, gitRunner) {
  const r = gitOf(gitRunner, ["for-each-ref", "--contains", branch, "--format=%(refname)", "refs/heads", "refs/remotes"], repo);
  if (r.status !== 0) fail(`for-each-ref --contains ${branch}`, r);
  const self = `refs/heads/${branch}`;
  return lines(r.stdout).some((ref) => ref !== self && !isSwarmRef(ref, prefix));
}

// `merge-tree --write-tree` arrived in git 2.38. Below it absorption is skipped, never
// Infinity — an unsupported option would otherwise refuse every prune permanently.
const mergeTreeSupport = new WeakMap();

function supportsMergeTree(repo, gitRunner) {
  if (!mergeTreeSupport.has(gitRunner)) mergeTreeSupport.set(gitRunner, readMergeTreeSupport(repo, gitRunner));
  return mergeTreeSupport.get(gitRunner);
}

function readMergeTreeSupport(repo, gitRunner) {
  const r = gitOf(gitRunner, ["version"], repo);
  if (r.status !== 0) fail("version", r);
  const m = /(\d+)\.(\d+)/.exec(r.stdout);
  if (!m) throw new Error(`git version unreadable: ${r.stdout}`);
  const [major, minor] = [Number(m[1]), Number(m[2])];
  const atLeast = ([needMajor, needMinor]) => major > needMajor || (major === needMajor && minor >= needMinor);
  return { writeTree: atLeast(MERGE_TREE_MIN_VERSION), batch: atLeast(MERGE_TREE_BATCH_VERSION) };
}

// A clean merge of `branch` into `commit` that reproduces `commit`'s tree: the
// branch adds nothing there. Exit 1 is that commit's definite no; anything else
// is unanswerable.
export function absorbedAt(commit, branch, repo, gitRunner) {
  const merged = gitOf(gitRunner, ["merge-tree", "--write-tree", commit, branch], repo);
  if (merged.status === 1) return false;
  if (merged.status !== 0) fail(`merge-tree ${commit} ${branch}`, merged);
  const tree = gitOf(gitRunner, ["rev-parse", `${commit}^{tree}`], repo);
  if (tree.status !== 0) fail(`rev-parse ${commit}^{tree}`, tree);
  const written = merged.stdout.split(/\r?\n/)[0]?.trim();
  return !!written && written === tree.stdout.split(/\r?\n/)[0]?.trim();
}

function* batchRows(output) {
  const fields = output.split("\0");
  let i = 0;
  const take = () => {
    if (i >= fields.length - 1) throw new Error("truncated merge-tree batch output");
    return fields[i++];
  };
  while (i < fields.length - 1) {
    const status = take();
    const tree = take();
    if (!/^[01]$/.test(status) || !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i.test(tree)) {
      throw new Error("malformed merge-tree batch row");
    }
    if (status === "0") {
      while (take() !== "") {}
      while (take() !== "") {}
    } else if (take() !== "") {
      throw new Error("malformed clean merge-tree row");
    }
    yield { clean: status === "1", tree };
  }
}

function absorbedBatch(commits, branch, repo, gitRunner, files) {
  const treesResult = gitOf(gitRunner, ["rev-parse", ...commits.map((commit) => `${commit}^{tree}`)], repo);
  if (treesResult.status !== 0) fail("rev-parse merge-tree batch", treesResult);
  const trees = lines(treesResult.stdout);
  if (trees.length !== commits.length) throw new Error("truncated rev-parse merge-tree batch");
  const input = commits.map((commit) => `${commit} ${branch}`).join("\n") + "\n";
  const merged = gitOf(gitRunner, ["merge-tree", "--write-tree", "--stdin", "-z"], repo, { input });
  const rows = batchRows(merged.stdout);
  for (let i = 0; i < commits.length; i++) {
    const row = rows.next();
    if (row.done) throw new Error("truncated merge-tree batch output");
    if (row.value.clean && row.value.tree === trees[i]) return !files.length || !hasMergeDriver(files, repo, gitRunner);
  }
  if (!rows.next().done) throw new Error("extra merge-tree batch rows");
  if (merged.status !== 0) fail("merge-tree batch", merged);
  return false;
}
// merge-tree honours `.gitattributes` merge drivers, so a `merge=ours` path
// silently takes the base's side. Any touched path carrying one makes tree
// equality worthless as evidence.
function hasMergeDriver(files, repo, gitRunner) {
  if (!files.length) return false;
  const r = gitOf(gitRunner, ["check-attr", "--stdin", "-z", "merge"], repo, { input: `${files.join("\0")}\0` });
  if (r.status !== 0) fail("check-attr merge", r);
  const parts = r.stdout.split("\0");
  for (let i = 0; i + 2 < parts.length; i += 3) {
    if (parts[i + 2] && parts[i + 2] !== "unspecified") return true;
  }
  return false;
}

function absorbedByTree(commit, branch, repo, gitRunner, files) {
  if (!absorbedAt(commit, branch, repo, gitRunner)) return false;
  return !hasMergeDriver(files, repo, gitRunner);
}

// `log` takes no pathspec-from-file, so the list arrives in chunks; one pathless
// rev-list restores the newest-first order, which a single chunk already has.
function touchingCommits(fork, base, files, repo, gitRunner) {
  const chunks = pathChunks(files);
  const found = new Set();
  const fromLog = [];
  for (const chunk of chunks) {
    const log = gitOf(gitRunner, ["log", "--first-parent", "--format=%H", `${fork}..${base}`, "--", ...chunk], repo);
    if (log.status !== 0) fail(`log ${fork}..${base}`, log);
    for (const sha of lines(log.stdout)) {
      found.add(sha);
      fromLog.push(sha);
    }
  }
  if (chunks.length === 1) return fromLog.slice(0, TOUCHING_SCAN_CAP);
  const rev = gitOf(gitRunner, ["rev-list", "--first-parent", `${fork}..${base}`], repo);
  if (rev.status !== 0) fail(`rev-list ${fork}..${base}`, rev);
  return lines(rev.stdout).filter((sha) => found.has(sha)).slice(0, TOUCHING_SCAN_CAP);
}

// Absorption tries the base's tip first, then each first-parent commit that
// touched the branch's files, newest first — the squash itself, once later
// commits have moved the same files on.
export function absorbed(base, branch, repo, gitRunner) {
  const support = supportsMergeTree(repo, gitRunner);
  if (!support.writeTree) return false;
  const mb = gitOf(gitRunner, ["merge-base", base, branch], repo);
  if (mb.status === 1) return false;
  if (mb.status !== 0) fail(`merge-base ${base} ${branch}`, mb);
  const diff = gitOf(gitRunner, ["diff", "--name-only", mb.stdout, branch], repo);
  if (diff.status !== 0) fail(`diff ${mb.stdout} ${branch}`, diff);
  const files = lines(diff.stdout);

  if (support.batch) {
    const touching = files.length ? touchingCommits(mb.stdout, base, files, repo, gitRunner) : [];
    return absorbedBatch([base, ...touching], branch, repo, gitRunner, files);
  }
  if (absorbedByTree(base, branch, repo, gitRunner, files)) return true;
  if (!files.length) return false;
  const touching = touchingCommits(mb.stdout, base, files, repo, gitRunner);
  return touching.some((commit) => absorbedByTree(commit, branch, repo, gitRunner, files));
}

// True only when the default branch holds `sha` or absorbs it — never any other ref,
// so a pushed-but-unmerged feature branch reads unlanded. `bases` are the default
// branch's commits, resolved once per repo by the caller. Fail-closed: an unreadable
// sha, a repo whose remotes name no default branch, or a git error is false, the safe
// answer for a caller deciding what may be lost.
export function landedOnDefault(sha, repo, { gitRunner, bases } = {}) {
  if (typeof gitRunner !== "function") throw new TypeError("landedOnDefault requires a gitRunner");
  if (!Array.isArray(bases)) throw new TypeError("landedOnDefault requires the default-branch bases");
  try {
    if (!bases.length) return false;
    const commit = gitOf(gitRunner, ["rev-parse", "--verify", `${sha}^{commit}`], repo);
    if (commit.status !== 0 || !commit.stdout) return false;
    for (const base of bases) {
      const contains = gitOf(gitRunner, ["merge-base", "--is-ancestor", commit.stdout, base], repo);
      if (contains.status === 0) return true;
      if (contains.status !== 1) return false;
    }
    return bases.some((base) => absorbed(base, commit.stdout, repo, gitRunner));
  } catch {
    return false;
  }
}

// 0 when the branch's work is held elsewhere; otherwise a count (at least 1) of
// what destroying it would lose; Infinity when git cannot answer.
// `extraBases` are caller-supplied commits to try as absorption bases first — the
// porting checkout's HEAD, which no ref on this repo's default branch holds after a
// cherry-pick. The caller picks them; the guard on what may be a base lives there.
export function unlandedCount(branch, repo, { prefix, gitRunner, extraBases } = {}) {
  if (typeof prefix !== "string" || !prefix) throw new TypeError("unlandedCount requires the branch prefix");
  if (typeof gitRunner !== "function") throw new TypeError("unlandedCount requires a gitRunner");
  if (!Array.isArray(extraBases)) throw new TypeError("unlandedCount requires an extraBases array");
  try {
    if (reachable(branch, repo, prefix, gitRunner)) return 0;
    const tip = gitOf(gitRunner, ["rev-parse", "--verify", `${branch}^{commit}`], repo);
    const own = tip.status === 0 ? tip.stdout : null;
    const extras = [];
    const seen = new Set();
    for (const sha of extraBases) {
      const r = gitOf(gitRunner, ["rev-parse", "--verify", `${sha}^{commit}`], repo);
      // A base at the branch's own tip absorbs trivially; a fast-forward port leaves a
      // ref on that tip, which `reachable` already counts.
      if (r.status !== 0 || !r.stdout || r.stdout === own || seen.has(r.stdout)) continue;
      seen.add(r.stdout);
      extras.push(r.stdout);
    }
    for (const base of extras) {
      if (absorbed(base, branch, repo, gitRunner)) return 0;
    }
    const defaults = candidateBases(repo, prefix, gitRunner);
    for (const base of defaults) {
      if (seen.has(base)) continue;
      if (absorbed(base, branch, repo, gitRunner)) return 0;
    }
    // The cherry count is defined against the default branch, never a caller's base.
    if (!defaults.length) return Infinity;
    const cherry = gitOf(gitRunner, ["cherry", defaults[0], branch], repo);
    if (cherry.status !== 0) return Infinity;
    return Math.max(1, lines(cherry.stdout).filter((l) => l.startsWith("+")).length);
  } catch {
    return Infinity;
  }
}
