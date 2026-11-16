// The port nudge: a run's branches are provable the moment they are ported, and the
// proof decays from there. After a command that can move HEAD, measure this session's
// finished runs with prune's own verdict, offering the porting checkout's HEAD as an
// extra landing base. Never a second definition of "landed".
import { basename, join, resolve } from "node:path";
import { enginePath, runsKeyFor } from "./config.mjs";
import { realRepoToplevel } from "./manifest-leaf-guard.mjs";
import { inLeafOrAutonomous, projectRunsHoldingWorktrees } from "./prune-nudge.mjs";
import { blockers, checkoutBase, discoveredLanes, plan, runForPrune } from "./prune.mjs";
import { absorbed, defaultBranchName } from "./landed.mjs";
import { portInProgress } from "./port-complete.mjs";
import { appendTaken, readTaken, refreshTaken, takenKey } from "./taken.mjs";
import { runLiveness } from "./runlog.mjs";
import { listTreeRecords } from "./worktree.mjs";
import { normalizeForCompare } from "./roots.mjs";

const CLI = enginePath();

// Verbs that can move a checkout's HEAD. A replay, a squash or `cherry-pick -n` moves
// only the working tree; their proof arrives at the `git commit` that follows.
export const PORT_RE = /\bgit\b(?:\s+-C\s+(?:"[^"]+"|'[^']+'|\S+)|\s+-c\s+\S+)*\s+(?:commit|merge|cherry-pick|rebase|am|pull)(?![\w-])/;

const C_FLAG = /(?:^|\s)-C\s+("([^"]*)"|'([^']*)'|(\S+))/g;
const LEADING_CD = /^\s*cd\s+("([^"]*)"|'([^']*)'|(\S+))\s*(?:&&|;)/;

// The one distinct `-C` path the command names, else the shell's directory: one leading
// `cd` is followed, since `cd <tree> && git cherry-pick` is the common port and the
// payload's cwd is then some other checkout.
export function portingTree(command, cwd) {
  const text = String(command);
  const cd = text.match(LEADING_CD);
  const base = cd ? resolve(cwd, cd[2] ?? cd[3] ?? cd[4]) : cwd;
  const found = new Map();
  for (const m of text.matchAll(C_FLAG)) {
    const path = m[2] ?? m[3] ?? m[4];
    if (!path) continue;
    const abs = resolve(base, path);
    found.set(normalizeForCompare(abs), abs);
  }
  return found.size === 1 ? [...found.values()][0] : base;
}

// Every swarm branch the command names, so a foreign run stays measurable after the
// session that dispatched it is gone. A trailing separator is punctuation, not a name.
export function namedSwarmBranches(command, prefix) {
  const escaped = String(prefix).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp("\\b" + escaped + "[^\\s\"'`:~^]+", "g");
  const out = new Set();
  for (const m of String(command).matchAll(re)) {
    const name = m[0].replace(/[),;.]+$/, "");
    if (name.length > prefix.length) out.add(name);
  }
  return [...out];
}

export const touchedPath = (home, sessionId) => join(home, `.port-touched-${sessionId}`);

// Append-only: parallel Bash calls fire concurrent hooks, and a read-modify-write
// would drop a name. The reader dedupes.
export function recordTouched({ home, sessionId, branches, fs }) {
  if (!branches.length) return;
  fs.appendFileSync(touchedPath(home, sessionId), `${branches.join("\n")}\n`);
  reapTouched({ home, fs });
}

const TOUCHED_TTL_MS = 14 * 24 * 60 * 60 * 1000;

// Nothing else ever deletes these logs, so the newest append reaps the rest. Every
// failure is a lost log, never a lost turn.
function reapTouched({ home, fs }) {
  let names;
  try { names = fs.readdirSync(home); } catch { return; }
  const cutoff = Date.now() - TOUCHED_TTL_MS;
  for (const name of names) {
    if (!name.startsWith(".port-touched-")) continue;
    const path = join(home, name);
    try {
      if (fs.statSync(path).mtimeMs < cutoff) fs.rmSync(path, { force: true });
    } catch { /* raced with another hook's reap */ }
  }
}

export function readTouched({ home, sessionId, fs }) {
  try {
    const lines = fs.readFileSync(touchedPath(home, sessionId), "utf8").split(/\r?\n/).filter(Boolean);
    return [...new Set(lines)];
  } catch {
    return [];
  }
}

const PORT_MARKER = "port-nudged";
export const portMarkerPath = (dir) => join(dir, PORT_MARKER);

export function writePortMarker(dir, sessionId, fs) {
  fs.writeFileSync(portMarkerPath(dir), sessionId);
}

function alreadyPortNudged(dir, sessionId, fs) {
  try { return fs.readFileSync(portMarkerPath(dir), "utf8") === sessionId; } catch { return false; }
}

// Finished runs of this repo that a touched branch says were dispatched elsewhere. The
// session that launched a run is often gone by the time its leaves are merged.
export function foreignTouchedRuns({ home, toplevel, touched, fs }) {
  if (!toplevel || !touched.length) return [];
  const root = join(home, "runs", runsKeyFor(toplevel));
  let names = [];
  try { names = fs.readdirSync(root); } catch { return []; }
  const out = [];
  for (const name of names) {
    const dir = join(root, name);
    const live = runLiveness(dir);
    if (live.finishedMs == null && live.stoppedMs == null) continue;
    if (listTreeRecords(dir).some((rec) => touched.includes(rec.branch))) out.push(dir);
  }
  return out;
}

function runFinishedAt(dir, fs) {
  try {
    const ms = Date.parse(JSON.parse(fs.readFileSync(join(dir, "summary.json"), "utf8")).finished);
    if (Number.isFinite(ms)) return ms;
  } catch { /* fall through to the dir's own clock */ }
  try { return fs.statSync(dir).mtimeMs; } catch { return 0; }
}

// This session's finished runs, plus the foreign runs its commands named, newest first.
// The nudge line and the taken record share this one list, so they never disagree about
// which runs a command is evidence for.
export function candidateRuns({ home, toplevel, sessionId, touched = [], cfg, fs }) {
  const mine = projectRunsHoldingWorktrees({ home, toplevel, sessionId, cfg }).mine.map((r) => r.dir);
  return [...new Set([...mine, ...foreignTouchedRuns({ home, toplevel, touched, fs })])]
    .sort((a, b) => runFinishedAt(b, fs) - runFinishedAt(a, fs));
}

// Those runs measured with `plan()` against the porting checkout's HEAD. Silent unless a
// run is wholly provable. `dirs`, `taken` and `buildRun` are the caller's seams: the hook
// reads the log and builds each run once and shares all three with the record pass.
export function portedRuns({ home, toplevel, sessionId, base, branch, portingTree, touched = [], cfg, git, fs, spawnSync, budgetMs = 20_000, dirs, taken, buildRun }) {
  if (!Array.isArray(dirs)) throw new TypeError("portedRuns requires the candidate run dirs");
  if (!(taken instanceof Map)) throw new TypeError("portedRuns requires a taken map");
  if (typeof buildRun !== "function") throw new TypeError("portedRuns requires a buildRun");
  const measured = dirs.filter((dir) => !alreadyPortNudged(dir, sessionId, fs));

  const startedMs = Date.now();
  const out = [];
  for (const dir of measured) {
    // The 30 s hook timeout is the hard edge; this keeps a many-run repo from reaching it.
    if (Date.now() - startedMs > budgetMs) break;
    const built = buildRun(dir);
    if (built.error) continue;
    const planned = plan(built.run, git, fs, {
      cfg, extraBases: [base], measureBytes: false, stopAtBlocker: true, deadline: startedMs + budgetMs, taken,
    });
    // A stopped plan proves nothing; the run is measured again on the next port verb.
    if (planned.stopped) continue;
    const rows = planned.rows;
    if (!rows.length || blockers(rows).length) continue;
    out.push({
      dir,
      name: basename(dir),
      rows,
      base,
      branch,
      portingTree,
      tasks: Array.isArray(built.summary?.tasks) ? built.summary.tasks : [],
    });
  }
  return out;
}

// One line per run: what has landed, where, and the command that frees it from the
// checkout whose HEAD proves it. An unfinished task is named, never a reason to hide it.
export function portReason({ dir, name, rows, base, branch, portingTree, tasks }) {
  const n = rows.length;
  const unfinished = tasks.filter((task) => task?.state !== "ok").length;
  const resume = unfinished
    ? ` (${unfinished} task${unfinished === 1 ? "" : "s"} did not finish ok — pruning ends their resume)`
    : "";
  return `swarm run \`${name}\` is ported — all ${n} branch${n === 1 ? "" : "es"} landed in \`${branch}\`@\`${String(base).slice(0, 7)}\`, trees clean. Prune it now, while git can still prove it: \`cd "${portingTree}" && node ${CLI} prune ${dir}\`${resume}`;
}

// The payload gate, shared by the hook's early exit and the measure path so the two
// can never disagree about who is asked.
export function isPortPayload(payload, env = {}) {
  const event = payload?.hook_event_name;
  if (event !== "PostToolUse" && event !== "PostToolUseFailure") return false;
  if (payload?.tool_name !== "Bash" && payload?.tool_name !== "PowerShell") return false;
  if (!String(payload?.session_id || "")) return false;
  return !inLeafOrAutonomous(env);
}

const RECORD_LANE_CAP = 12;
const RECORD_MIN_BUDGET_MS = 10_000;

// The proof decays: a lane absorbed by this checkout's HEAD is unprovable once the branch
// is rewritten, so it is written down while git can still answer.
function recordPorts({ home, toplevel, tree, into, base, dirs, cfg, git, fs, buildRun, taken, startedMs, budgetMs }) {
  if (!into || into === defaultBranchName(git, tree)) return;
  if (portInProgress(tree, git)) return;
  const deadline = startedMs + budgetMs - RECORD_MIN_BUDGET_MS;
  refreshTaken({ home, toplevel, into, head: base, git, fs, known: taken, deadline });
  if (!dirs.length || Date.now() >= deadline) return;
  let left = RECORD_LANE_CAP;
  for (const dir of dirs) {
    const built = buildRun(dir);
    if (built.error) continue;
    const name = basename(dir);
    // The lanes prune's own discovery finds, never the summary alone: a killed run may have
    // written none, and a partial prune leaves one that names no surviving tree.
    for (const lane of discoveredLanes(built.run, git, fs, { cfg })) {
      if (!lane.branch || !lane.repo) continue;
      const key = takenKey({ run: name, repo: lane.repo, branch: lane.branch });
      if (taken.has(key)) continue;
      if (left <= 0 || Date.now() >= deadline) return;
      try {
        const tip = git(["rev-parse", "--verify", `${lane.branch}^{commit}`], lane.repo);
        if (tip.status !== 0 || !tip.stdout) continue;
        left -= 1;
        // Ancestry, then absorption: never unlandedCount, whose ref-reachability shortcut
        // would let an unrelated branch gate a record for a port this HEAD never saw.
        const ancestor = git(["merge-base", "--is-ancestor", lane.branch, base], lane.repo);
        // Absorption is up to 20 merge-tree probes: too many to start on a spent budget.
        const proven = ancestor.status === 0
          || (ancestor.status === 1 && Date.now() < deadline && absorbed(base, lane.branch, lane.repo, git));
        if (!proven) continue;
        const record = { run: name, branch: lane.branch, laneTip: tip.stdout, repo: lane.repo, into, portCommit: base, intoTip: base };
        appendTaken({ home, toplevel, fs, records: [record] });
        taken.set(key, record);
      } catch { /* one lane git cannot answer costs that lane, not the firing */ }
    }
  }
}

// The whole hook flow below the CLI seams, so a test can count git calls. Returns the
// line to print, or "" when there is nothing to say.
export function runPortNudge({ payload, env = {}, config, home, git, spawn, fs, budgetMs = 20_000 }) {
  if (!isPortPayload(payload, env)) return "";
  if (config?.swarm?.pruneNudge === false) return "";
  const sessionId = String(payload.session_id);
  const command = String(payload?.tool_input?.command || "");
  const prefix = config?.worktreeBranchPrefix || "swarm/";

  // Recorded before the verb test: a leaf's branch is usually named by a merge or a
  // diff, and the run it belongs to may be another session's.
  const named = namedSwarmBranches(command, prefix);
  if (named.length) {
    try { recordTouched({ home, sessionId, branches: named, fs }); } catch { /* a lost log costs recall, not the turn */ }
  }
  if (!PORT_RE.test(command)) return "";

  const tree = portingTree(command, payload?.cwd || process.cwd());
  const toplevel = realRepoToplevel(tree, spawn);
  if (!toplevel) return "";
  const base = checkoutBase(git, tree, [toplevel], prefix);
  if (!base) return "";
  const head = git(["symbolic-ref", "-q", "HEAD"], tree);
  if (head.status !== 0 || !head.stdout) return "";
  const branch = head.stdout.replace(/^refs\/heads\//, "");

  const startedMs = Date.now();
  const touched = readTouched({ home, sessionId, fs });
  const dirs = candidateRuns({ home, toplevel, sessionId, touched, cfg: config, fs });
  // One read of the taken log, one build per run: the nudge line and the record share both.
  const taken = readTaken({ home, toplevel, fs });
  const built = new Map();
  const buildRun = (dir) => {
    if (!built.has(dir)) built.set(dir, runForPrune(dir, { fs, spawnSync: spawn }));
    return built.get(dir);
  };
  // Recorded before the measure, and before the silence test: a run already nudged this
  // session still needs its witness refreshed, a partly ported run still holds lanes this
  // HEAD did port, and a measure that spends the budget must not leave recording none of it.
  try {
    recordPorts({ home, toplevel, tree, into: branch, base, dirs, cfg: config, git, fs, buildRun, taken, startedMs, budgetMs });
  } catch { /* a lost record costs recall, never the turn */ }
  const runs = portedRuns({
    home,
    toplevel,
    sessionId,
    base,
    branch,
    portingTree: tree,
    touched,
    cfg: config,
    git,
    fs,
    spawnSync: spawn,
    budgetMs,
    dirs,
    taken,
    buildRun,
  });
  if (!runs.length) return "";

  const additionalContext = runs.map(portReason).join("\n");
  const output = JSON.stringify({ hookSpecificOutput: { hookEventName: payload.hook_event_name, additionalContext } }) + "\n";
  // Markers after the line: a marker that cannot be written costs one repeat, never the nudge.
  for (const run of runs) {
    try { writePortMarker(run.dir, sessionId, fs); } catch { /* the next trigger repeats the line */ }
  }
  return output;
}
