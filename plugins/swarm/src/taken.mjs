// The proof that a lane was ported into another branch, recorded while it exists.
// One append-only log per repo: parallel hooks append concurrently, so a line is
// never rewritten. Landing is decided later, against the default branch alone.
import { basename, dirname, join } from "node:path";
import { runsKeyFor } from "./config.mjs";
import { gitOf, landedOnDefault } from "./landed.mjs";
import { normalizeForCompare } from "./roots.mjs";

const MAX_LOG_BYTES = 1024 * 1024;

export function takenLogPath(home, toplevel) {
  return join(home, "taken", `${runsKeyFor(toplevel)}.jsonl`);
}

// A run's lanes carry the same names in every repo it spans, so the repo is part of the key.
export const takenKey = ({ run, repo, branch }) =>
  `${run}\n${repo ? normalizeForCompare(repo) : ""}\n${branch}`;

// Past 1 MB the live log is renamed aside to a unique generation and readers take every
// generation. Nothing is ever unlinked, so a second hook's rename fails — the live log is
// already gone — instead of deleting the rotation the first hook just made.
let generation = 0;

// Per-process state, so an in-process CLI call starts from the same place a
// fresh child would.
export function resetForTests() {
  generation = 0;
}

function rotateIfFull(logPath, fs) {
  let size;
  try { size = fs.statSync(logPath).size; } catch { return; }
  if (size <= MAX_LOG_BYTES) return;
  try { fs.renameSync(logPath, `${logPath}.${Date.now()}-${process.pid}-${generation++}`); }
  catch { /* another hook rotated this log first; this append lands in the live log */ }
}

export function appendTaken({ home, toplevel, records, fs }) {
  if (!records?.length) return;
  const logPath = takenLogPath(home, toplevel);
  fs.mkdirSync(dirname(logPath), { recursive: true });
  rotateIfFull(logPath, fs);
  const at = new Date().toISOString();
  const text = records.map((rec) => JSON.stringify({ ...rec, at: rec.at || at })).join("\n") + "\n";
  // One write per call: concurrent appends interleave by line, never by fragment.
  fs.appendFileSync(logPath, text);
}

// Every rotation, oldest first, then the live log last so its line is the newest read.
function logFiles(logPath, fs) {
  const dir = dirname(logPath);
  const stem = `${basename(logPath)}.`;
  let names;
  try { names = fs.readdirSync(dir); } catch { return [logPath]; }
  const rotated = [];
  for (const name of names) {
    if (!name.startsWith(stem)) continue;
    const file = join(dir, name);
    try { rotated.push({ file, mtime: fs.statSync(file).mtimeMs }); } catch { /* raced away */ }
  }
  rotated.sort((a, b) => a.mtime - b.mtime);
  return [...rotated.map((entry) => entry.file), logPath];
}

// Newest line per lane wins, across every generation. A run whose dir is gone is history
// no prune can act on — asked once per run, never once per line, so a full log costs a
// handful of stats rather than thousands.
export function readTaken({ home, toplevel, fs }) {
  const logPath = takenLogPath(home, toplevel);
  const runsRoot = join(home, "runs", runsKeyFor(toplevel));
  const alive = new Map();
  const runAlive = (run) => {
    if (!alive.has(run)) alive.set(run, fs.existsSync(join(runsRoot, run)));
    return alive.get(run);
  };
  const out = new Map();
  for (const file of logFiles(logPath, fs)) {
    let text;
    try { text = fs.readFileSync(file, "utf8"); } catch { continue; }
    for (const line of text.split(/\r?\n/)) {
      if (!line) continue;
      let rec;
      try { rec = JSON.parse(line); } catch { continue; }
      if (typeof rec?.run !== "string" || typeof rec?.branch !== "string") continue;
      if (!runAlive(rec.run)) continue;
      out.set(takenKey(rec), rec);
    }
  }
  return out;
}

// A later firing on the same branch moves the witness forward, but only along descent:
// a reset or recreated branch stops refreshing instead of overwriting the proof.
// `portCommit` is the original witness and never changes. `deadline` (epoch ms) keeps a
// call-heavy firing inside the hook's own budget.
export function refreshTaken({ home, toplevel, into, head, git, fs, known, deadline = Infinity }) {
  if (!into || !head) return [];
  const records = known ?? readTaken({ home, toplevel, fs });
  const moved = [];
  for (const rec of records.values()) {
    if (rec.into !== into || rec.intoTip === head) continue;
    if (Date.now() >= deadline) break;
    const r = gitOf(git, ["merge-base", "--is-ancestor", rec.intoTip, head], toplevel);
    if (r.status !== 0) continue;
    const refreshed = { ...rec, intoTip: head };
    delete refreshed.at;
    moved.push(refreshed);
    records.set(takenKey(refreshed), refreshed);
  }
  appendTaken({ home, toplevel, records: moved, fs });
  return moved;
}

function lines(text) {
  return String(text).split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
}

// The branch's tip, local first, then the first remote-tracking copy of the same name.
function branchTip(into, repo, gitRunner) {
  const local = gitOf(gitRunner, ["rev-parse", "--verify", `refs/heads/${into}^{commit}`], repo);
  if (local.status === 0 && local.stdout) return local.stdout;
  const remotes = gitOf(gitRunner, ["for-each-ref", "--format=%(refname)", "refs/remotes"], repo);
  if (remotes.status !== 0) return null;
  for (const ref of lines(remotes.stdout)) {
    if (!ref.endsWith(`/${into}`)) continue;
    const r = gitOf(gitRunner, ["rev-parse", "--verify", `${ref}^{commit}`], repo);
    if (r.status === 0 && r.stdout) return r.stdout;
  }
  return null;
}

// The branch as it stands when it descends from the port; otherwise the last tip the
// hook saw, which survives the branch's deletion for as long as git keeps the object.
function candidateTip(record, repo, gitRunner) {
  const tip = branchTip(record.into, repo, gitRunner);
  if (tip) {
    const descends = gitOf(gitRunner, ["merge-base", "--is-ancestor", record.portCommit, tip], repo);
    if (descends.status === 0) return tip;
  }
  const recorded = gitOf(gitRunner, ["rev-parse", "--verify", `${record.intoTip}^{commit}`], repo);
  return recorded.status === 0 && recorded.stdout ? recorded.stdout : null;
}

// Landed only when the target's tip is on the default branch. Everything unprovable
// stays unlanded, and a lane that moved after the record makes it stale. `bases` are the
// caller's resolved default-branch commits, so a multi-lane plan asks git once per repo.
export function takenVerdict({ record, laneTip, repo, gitRunner, bases }) {
  if (!record?.into) return { landed: false, reason: "no taken record" };
  const into = record.into;
  try {
    if (!laneTip || laneTip !== record.laneTip) {
      return { landed: false, reason: `taken into \`${into}\`, but the lane has moved since` };
    }
    const tip = candidateTip(record, repo, gitRunner);
    if (!tip) return { landed: false, reason: `taken into \`${into}\`; the recorded tip is gone` };
    if (!landedOnDefault(tip, repo, { gitRunner, bases })) {
      return { landed: false, reason: `taken into \`${into}\`; \`${into}\` not landed yet` };
    }
    return { landed: true, reason: `taken into \`${into}\`` };
  } catch {
    return { landed: false, reason: `taken into \`${into}\`; git could not answer` };
  }
}
