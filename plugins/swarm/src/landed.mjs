// "Landed" means destroying this branch loses nothing: a ref outside the swarm prefix
// holds its tip, or a base already absorbs it. An unreadable git answer is Infinity.

const TIMEOUT = 60000;
const TOUCHING_SCAN_CAP = 20;
const MERGE_TREE_MIN_VERSION = [2, 38];

function gitOf(gitRunner, args, repo, opts = {}) {
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

// The default branch and the checked-out branch: where work lands. Remote refs
// are not scanned — merge-tree across every ref costs seconds per branch.
export function candidateBases(repo, prefix, gitRunner) {
  const refs = [];
  const origin = gitOf(gitRunner, ["symbolic-ref", "refs/remotes/origin/HEAD"], repo);
  if (origin.status === 0 && origin.stdout) {
    refs.push(origin.stdout);
    refs.push(`refs/heads/${origin.stdout.replace(/^refs\/remotes\/origin\//, "")}`);
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
  return major > MERGE_TREE_MIN_VERSION[0]
    || (major === MERGE_TREE_MIN_VERSION[0] && minor >= MERGE_TREE_MIN_VERSION[1]);
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
  if (!supportsMergeTree(repo, gitRunner)) return false;
  const mb = gitOf(gitRunner, ["merge-base", base, branch], repo);
  if (mb.status === 1) return false;
  if (mb.status !== 0) fail(`merge-base ${base} ${branch}`, mb);
  const diff = gitOf(gitRunner, ["diff", "--name-only", mb.stdout, branch], repo);
  if (diff.status !== 0) fail(`diff ${mb.stdout} ${branch}`, diff);
  const files = lines(diff.stdout);

  if (absorbedByTree(base, branch, repo, gitRunner, files)) return true;
  if (!files.length) return false;
  const touching = touchingCommits(mb.stdout, base, files, repo, gitRunner);
  return touching.some((commit) => absorbedByTree(commit, branch, repo, gitRunner, files));
}

// 0 when the branch's work is held elsewhere; otherwise a count (at least 1) of
// what destroying it would lose; Infinity when git cannot answer.
export function unlandedCount(branch, repo, { prefix, gitRunner } = {}) {
  if (typeof prefix !== "string" || !prefix) throw new TypeError("unlandedCount requires the branch prefix");
  if (typeof gitRunner !== "function") throw new TypeError("unlandedCount requires a gitRunner");
  try {
    if (reachable(branch, repo, prefix, gitRunner)) return 0;
    const bases = candidateBases(repo, prefix, gitRunner);
    for (const base of bases) {
      if (absorbed(base, branch, repo, gitRunner)) return 0;
    }
    if (!bases.length) return Infinity;
    const cherry = gitOf(gitRunner, ["cherry", bases[0], branch], repo);
    if (cherry.status !== 0) return Infinity;
    return Math.max(1, lines(cherry.stdout).filter((l) => l.startsWith("+")).length);
  } catch {
    return Infinity;
  }
}
