// The Stop-hook backstop for grading: which runs THIS session dispatched still
// have no rows in the score store. The engine asks for grading in the run's
// closing block — on the run's stdout, the one place a dispatching session
// never reads, because every dispatch goes through a background Bash. This
// module owns the mechanics; hooks/grade-nudge.mjs is the thin stdin/stdout
// wrapper, and the decision below is pure over injected state so tests never
// spawn a hook binary (the plugin's established seam: decideNudge, decide).
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { swarmHome } from "./config.mjs";
import { canonicalRunKey } from "./scores.mjs";

// The engine CLI the block reason names — the same command shape the run's
// own closing block prints, pasteable from any shell.
const CLI = fileURLToPath(new URL("../scripts/swarm.mjs", import.meta.url));

// The last run-start event in a run.log — a run's current owner. A resume
// appends a second run-start (81 of 658 runs in the real estate), so the last
// one wins: matching any stamped run-start would nag the original session
// about a run whose context a resumer now holds. Only lines naming run-start
// are parsed — the walk below reads every run.log on disk — and a torn line is
// skipped, never thrown, because mid-run logs have torn tails.
export function lastRunStart(text) {
  let last = null;
  for (const line of String(text).split("\n")) {
    if (!line.includes('"run-start"')) continue;
    let e;
    try { e = JSON.parse(line); } catch { continue; }
    if (e && e.event === "run-start") last = e;
  }
  return last;
}

// Every run under <home>/runs that has something to grade and no store rows.
// Walks EVERY encoded-cwd directory: the encoding is the dispatching shell's
// cwd, not the Stop payload's, so deriving one encoding misses runs (24
// encodings in the real estate; swarm-statusline.mjs walks all for the same
// reason). Runs dispatched with an explicit manifest resultsDir never appear —
// they leave the runs tree entirely. Each row is { dir, key, launcher };
// launcher is null when the owning run-start carries no stamp, so the run
// belongs to nobody rather than to whoever asks about it next.
// _readFile is the injection seam the ordering test counts through — the only
// way to prove the cheap predicates run first, since skipping a run and reading
// its log then skipping it produce the same output.
export function ungradedRuns({ env = process.env, home = swarmHome(env), graded = new Set(), _readFile = readFileSync } = {}) {
  const out = [];
  const runsRoot = join(home, "runs");
  let encodings = [];
  try { encodings = readdirSync(runsRoot); } catch { return out; }
  for (const enc of encodings) {
    let names = [];
    try { names = readdirSync(join(runsRoot, enc)); } catch { continue; }
    for (const name of names) {
      const dir = join(runsRoot, enc, name);
      // Cheapest predicates first: run.log is the expensive read (45.6MB across
      // the estate, largest 2.2MB) and every stop pays for the whole walk, so a
      // run already graded or with nothing to grade must never reach it.
      const key = canonicalRunKey(dir);
      if (key == null || graded.has(key)) continue;
      // Nothing to grade: no results/ dir, or no result file in it — agentless
      // nodes produce no row and skipped leaves write none.
      let files = [];
      try { files = readdirSync(join(dir, "results")); } catch { continue; }
      if (!files.some((f) => f.endsWith(".json"))) continue;
      let text;
      try { text = _readFile(join(dir, "run.log"), "utf8"); } catch { continue; } // not a run dir
      const start = lastRunStart(text);
      if (!start) continue;
      out.push({ dir, key, launcher: typeof start.launcher === "string" ? start.launcher : null });
    }
  }
  return out;
}

// Pure: given the walked runs, the store's graded keys, this session's id and
// the once-per-session markers, should this stop be blocked? A run is listed
// iff its owning run-start was stamped with THIS session and the store holds
// no row for its canonical key. Grading is a discrete task, so the marker is
// once per session — never a cooldown.
export function decideGradeNudge({ config, runs, graded, sessionId, seen }) {
  if (config?.grading?.enabled !== true) return { block: false, reason: null };
  if (!sessionId) return { block: false, reason: null };
  const mine = (runs || []).filter((r) => r.launcher === sessionId && !graded?.has(r.key));
  if (!mine.length) return { block: false, reason: null };
  if (seen?.[sessionId]) return { block: false, reason: null };
  return { block: true, reason: gradeNudgeReason(mine) };
}

function gradeNudgeReason(runs) {
  const one = runs.length === 1;
  return [
    `${runs.length} swarm run${one ? "" : "s"} this session dispatched ${one ? "has" : "have"} no rows in the grading store (grading.enabled is on) — ungraded evidence never reaches \`swarm perf\`, which then decays back into routing by remembered incidents.`,
    `Grade each results dir: fill every universal aspect 1-10, drop \`grades\` on rows whose leaf produced no output, then \`swarm grade --file\` the grades.json it prints.`,
    ...runs.map((r) => `  node ${CLI} grade --init ${r.dir}`),
    `If these runs are not worth grading, simply stop again — this reminder fires once per session.`,
  ].join("\n");
}