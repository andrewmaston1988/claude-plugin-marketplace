// The port nudge: a run's branches are provable the moment they are ported, and the
// proof decays from there. After a command that can move HEAD, measure this session's
// finished runs with prune's own verdict, offering the porting checkout's HEAD as an
// extra landing base. Never a second definition of "landed".
import { basename, join, resolve } from "node:path";
import { enginePath, runsKeyFor } from "./config.mjs";
import { realRepoToplevel } from "./manifest-leaf-guard.mjs";
import { inLeafOrAutonomous, projectRunsHoldingWorktrees } from "./prune-nudge.mjs";
import { blockers, checkoutBase, plan, runForPrune } from "./prune.mjs";
import { runLiveness } from "./runlog.mjs";
import { listTreeRecords } from "./worktree.mjs";
import { normalizeForCompare } from "./roots.mjs";

const CLI = enginePath();

// Verbs that can move a checkout's HEAD. A replay, a squash or `cherry-pick -n` moves
// only the working tree; their proof arrives at the `git commit` that follows.
export const PORT_RE = /\bgit\b(?:\s+-C\s+(?:"[^"]+"|'[^']+'|\S+)|\s+-c\s+\S+)*\s+(?:commit|merge|cherry-pick|rebase|am|pull)(?![\w-])/;

const C_FLAG = /(?:^|\s)-C\s+("([^"]*)"|'([^']*)'|(\S+))/g;

// The one distinct `-C` path the command names, else the payload's cwd. A `cd` inside
// the command is not followed — this is the checkout git itself was pointed at.
export function portingTree(command, cwd) {
  const found = new Map();
  for (const m of String(command).matchAll(C_FLAG)) {
    const path = m[2] ?? m[3] ?? m[4];
    if (!path) continue;
    const abs = resolve(cwd, path);
    found.set(normalizeForCompare(abs), abs);
  }
  return found.size === 1 ? [...found.values()][0] : cwd;
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

// This session's finished runs, plus the foreign runs its commands named, measured with
// `plan()` against the porting checkout's HEAD. Silent unless a run is wholly provable.
export function portedRuns({ home, toplevel, sessionId, base, branch, portingTree, touched = [], cfg, git, fs, spawnSync, budgetMs = 20_000 }) {
  const mine = projectRunsHoldingWorktrees({ home, toplevel, sessionId, cfg }).mine.map((r) => r.dir);
  const dirs = [...new Set([...mine, ...foreignTouchedRuns({ home, toplevel, touched, fs })])]
    .filter((dir) => !alreadyPortNudged(dir, sessionId, fs))
    .sort((a, b) => runFinishedAt(b, fs) - runFinishedAt(a, fs));

  const startedMs = Date.now();
  const out = [];
  for (const dir of dirs) {
    // The 30 s hook timeout is the hard edge; this keeps a many-run repo from reaching it.
    if (Date.now() - startedMs > budgetMs) break;
    const built = runForPrune(dir, { fs, spawnSync });
    if (built.error) continue;
    const rows = plan(built.run, git, fs, { cfg, extraBases: [base], measureBytes: false }).rows;
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

  const runs = portedRuns({
    home,
    toplevel,
    sessionId,
    base,
    branch: head.stdout.replace(/^refs\/heads\//, ""),
    portingTree: tree,
    touched: readTouched({ home, sessionId, fs }),
    cfg: config,
    git,
    fs,
    spawnSync: spawn,
    budgetMs,
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
