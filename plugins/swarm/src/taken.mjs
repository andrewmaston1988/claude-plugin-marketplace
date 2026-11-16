// The proof that a lane was ported into another branch, recorded while it exists.
// One append-only log per repo: parallel hooks append concurrently, so a line is
// never rewritten. Landing is decided later, against the default branch alone.
import { dirname, join } from "node:path";
import { runsKeyFor } from "./config.mjs";
import { landedOnDefault } from "./landed.mjs";

const TIMEOUT = 60000;
const MAX_LOG_BYTES = 1024 * 1024;

export function takenLogPath(home, toplevel) {
  return join(home, "taken", `${runsKeyFor(toplevel)}.jsonl`);
}

const recordKey = (rec) => `${rec.run}\n${rec.branch}`;

// Past 1 MB the log becomes `.1` and readers take both. Windows will not rename
// onto an existing file, so the older rotation goes first; a race here loses the
// rotation, never a line.
function rotateIfFull(logPath, fs) {
  let size;
  try { size = fs.statSync(logPath).size; } catch { return; }
  if (size <= MAX_LOG_BYTES) return;
  try {
    fs.rmSync(`${logPath}.1`, { force: true });
    fs.renameSync(logPath, `${logPath}.1`);
  } catch { /* another hook rotated first, or the file is held open */ }
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

// Newest line per (run, lane) wins; `.1` is the older rotation, so it is read first.
// A run whose dir is gone is history no prune can act on.
export function readTaken({ home, toplevel, fs }) {
  const logPath = takenLogPath(home, toplevel);
  const runsRoot = join(home, "runs", runsKeyFor(toplevel));
  const out = new Map();
  for (const file of [`${logPath}.1`, logPath]) {
    let text;
    try { text = fs.readFileSync(file, "utf8"); } catch { continue; }
    for (const line of text.split(/\r?\n/)) {
      if (!line) continue;
      let rec;
      try { rec = JSON.parse(line); } catch { continue; }
      if (typeof rec?.run !== "string" || typeof rec?.branch !== "string") continue;
      if (!fs.existsSync(join(runsRoot, rec.run))) continue;
      out.set(recordKey(rec), rec);
    }
  }
  return out;
}

// A later firing on the same branch moves the witness forward, but only along descent:
// a reset or recreated branch stops refreshing instead of overwriting the proof.
// `portCommit` is the original witness and never changes.
export function refreshTaken({ home, toplevel, into, head, git, fs }) {
  if (!into || !head) return [];
  const moved = [];
  for (const rec of readTaken({ home, toplevel, fs }).values()) {
    if (rec.into !== into || rec.intoTip === head) continue;
    const r = git(["merge-base", "--is-ancestor", rec.intoTip, head], toplevel, { timeout: TIMEOUT });
    if (r.status !== 0) continue;
    const refreshed = { ...rec, intoTip: head };
    delete refreshed.at;
    moved.push(refreshed);
  }
  appendTaken({ home, toplevel, records: moved, fs });
  return moved;
}

function lines(text) {
  return String(text).split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
}

function gitOf(gitRunner, args, repo) {
  return gitRunner(args, repo, { timeout: TIMEOUT });
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
// stays unlanded, and a lane that moved after the record makes it stale.
export function takenVerdict({ record, laneTip, repo, prefix, gitRunner }) {
  if (!record?.into) return { landed: false, reason: "no taken record" };
  const into = record.into;
  try {
    if (!laneTip || laneTip !== record.laneTip) {
      return { landed: false, reason: `taken into \`${into}\`, but the lane has moved since` };
    }
    const tip = candidateTip(record, repo, gitRunner);
    if (!tip) return { landed: false, reason: `taken into \`${into}\`; the recorded tip is gone` };
    if (!landedOnDefault(tip, repo, { prefix, gitRunner })) {
      return { landed: false, reason: `taken into \`${into}\`; \`${into}\` not landed yet` };
    }
    return { landed: true, reason: `taken into \`${into}\`` };
  } catch {
    return { landed: false, reason: `taken into \`${into}\`; git could not answer` };
  }
}
