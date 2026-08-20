#!/usr/bin/env node
/**
 * run-swarm.mjs — driver for the swarm skill's SESSION-side sequence.
 *
 * The engine already resumes: src/scheduler.mjs is a DAG state machine with
 * per-leaf `claude --resume`, kept worktrees, and skip-if-ok. What has no
 * persisted state is the session's own sequence — gate answered, validated,
 * dispatched, liveness checked, digest read — and both documented incidents
 * (2026-07-15) were lost-session-state failures, not knowledge failures.
 *
 * What this driver is NOT: an enforcement mechanism. A5 (2026-08-20) enumerated
 * the dispatch paths and found three, of which the Bash hook guards one —
 * `src/ask.mjs` and any direct `runPlan` import spend without consulting a
 * marker. The gate prose in SKILL.md governs those; this script records the
 * answer so it survives compaction, and writes the marker IN ADDITION to
 * skill-ack.mjs (never instead of it — that would break by-hand dispatch).
 *
 * Three exit modes:
 *   pause banner + exit 0   — a judgement call is needed
 *   needInput JSON + exit 0 — a required input is missing
 *   non-zero                — genuine failure
 * Never exit 0 with no output: a silent success cannot be told from a silent
 * failure by a caller branching on those modes.
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync, renameSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

// ── Exit modes ────────────────────────────────────────────────────────────────

export function banner(what, lines, rerun) {
  const bar = "=".repeat(78);
  return [bar, `> PAUSE: ${what}`, "", ...lines, "", "RE-RUN EXACTLY:", `  ${rerun}`, bar, ""].join("\n");
}

export function needInput(field, hint) {
  return JSON.stringify({ error: "missing_required_field", field, hint }) + "\n";
}

// ── Gate answers ──────────────────────────────────────────────────────────────

// The three questions the skill's offer gate poses. The ANSWERS are the user's;
// the driver only records them.
export const GATE_KEYS = ["fanout", "mix", "batching"];

// Presence, not truthiness. An empty string and a "no" are real answers — gating
// on `!meta[k]` makes the honest answer unreachable and loops the pause forever
// (the shipped defect in run-workflow.mjs's --plans-line).
export function gateAnswered(meta = {}) {
  return GATE_KEYS.every((k) => k in meta);
}

export function recordGate(meta = {}, key, value) {
  if (value === undefined) return meta; // absent flag must not clobber a stored answer
  return { ...meta, [key]: value };
}

// ── Inline-cost arithmetic ────────────────────────────────────────────────────

// The skill's formula: total lines x ~10. `none` on a cold corpus is itself the
// honest answer — never invent a number for either side of the comparison.
export function inlineEstimate({ totalLines = 0, comparable = true } = {}) {
  if (!comparable) return { tokens: null, text: "inline: not comparable" };
  if (!totalLines) return { tokens: null, text: "inline: none (cold corpus — no line count)" };
  const tokens = totalLines * 10;
  return { tokens, text: `inline: ~${Math.round(tokens / 1000)}k tokens` };
}

// ── Liveness ──────────────────────────────────────────────────────────────────

// ONE check, immediately after dispatch. A bare re-run of an already-complete
// manifest replays cache and exits in seconds; a session that skipped this
// announced "Round 3 is running" when nothing was.
export function livenessVerdict({ states = [], skipped = 0, total = 0 } = {}) {
  const live = states.includes("running") || states.includes("retrying");
  if (live) return { live: true, cacheReplay: false, reason: "at least one leaf is running" };
  const allSkipped = total > 0 && skipped === total;
  if (allSkipped) {
    return {
      live: false,
      cacheReplay: true,
      reason: `cache replay — ${skipped}/${total} [skipped], nothing re-executed`,
    };
  }
  return { live: false, cacheReplay: false, reason: "no leaf is running" };
}

// ── Failure routing ───────────────────────────────────────────────────────────

// A decision table over (timedOut, erroredOnce, committedSince). Commits since
// the last attempt is the discriminator, NOT attempt count: auto-resume at the
// same timeout converges for a leaf that made progress and loops for one that
// did not.
export function routeFailure({ timedOut = false, erroredOnce = false, committedSince = false, quota = false, attempts = 1 } = {}) {
  const options = ["Resume (Recommended)", "Inspect failures", "Accept partial"];
  if (quota) options.push("Recast to :cloud models");

  if (quota) {
    return { action: "ask", ask: true, options, reason: "Anthropic usage exhausted" };
  }
  if (erroredOnce) {
    return attempts <= 1
      ? { action: "retry", ask: false, options, reason: "one automatic retry distinguishes transient from structural" }
      : { action: "ask", ask: true, options, reason: "error persisted past one retry" };
  }
  if (timedOut) {
    if (attempts >= 2 && !committedSince) {
      return { action: "ask", ask: true, options, reason: "second timeout with no commits since the last attempt" };
    }
    // A timeout is self-diagnosing; asking has no decision content and stalls an
    // unattended run overnight.
    return { action: "rerun", ask: false, options, reason: "timeout — re-run without asking" };
  }
  return { action: "ask", ask: true, options, reason: "unclassified failure" };
}

// ── Results dir ───────────────────────────────────────────────────────────────

// COPY the engine's printed line; never reconstruct from the manifest stem. A
// session that guessed published `…/p5-review-2`, a path that never existed.
export function captureResultsDir(stdout) {
  const m = String(stdout ?? "").match(/^\s*resultsDir:\s*(\S+)\s*$/m);
  return m ? m[1] : null;
}

// ── Progress state ────────────────────────────────────────────────────────────

const STATE_DIR = join(process.env.SWARM_HOME || join(process.env.USERPROFILE || process.env.HOME || ".", ".swarm"), "driver");

export function statePath(manifest) {
  const stem = String(manifest).split(/[/\\]/).pop().replace(/\.json$/i, "");
  return join(STATE_DIR, `${stem}.json`);
}

export function readState(manifest) {
  const p = statePath(manifest);
  if (!existsSync(p)) return null;
  try { return JSON.parse(readFileSync(p, "utf8")); } catch { return null; }
}

export function writeState(manifest, state, { dryRun = false } = {}) {
  if (dryRun) return state; // a rehearsal must not mutate what it rehearses
  const p = statePath(manifest);
  mkdirSync(dirname(p), { recursive: true });
  // Write-then-rename: a crash mid-write must leave the previous state intact,
  // not a truncated file. Copying tmp over the target would not achieve that.
  const tmp = `${p}.tmp`;
  writeFileSync(tmp, JSON.stringify(state, null, 2));
  renameSync(tmp, p);
  return state;
}

// ── main ──────────────────────────────────────────────────────────────────────

function getFlag(name, argv) {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
}

async function main() {
  const argv = process.argv.slice(2);
  const out = (s) => process.stdout.write(s);

  const manifest = getFlag("manifest", argv);
  if (!manifest) {
    out(needInput("manifest", "Which manifest? e.g. --manifest plan.json (or a saved name)"));
    return 0;
  }

  const dryRun = argv.includes("--dry-run");
  const state = readState(manifest) || { manifest, meta: {} };

  let meta = state.meta || {};
  for (const key of GATE_KEYS) {
    meta = recordGate(meta, key, getFlag(`gate-${key}`, argv));
  }
  state.meta = meta;
  writeState(manifest, state, { dryRun });

  if (!gateAnswered(meta)) {
    const missing = GATE_KEYS.filter((k) => !(k in meta));
    const self = fileURLToPath(import.meta.url).split("\\").join("/");
    const rerun =
      `node "${self}" --manifest "${manifest}" ` +
      missing.map((k) => `--gate-${k} "<answer>"`).join(" ");
    out(
      banner(
        "The offer gate — the user's answer is the only consent to spend",
        [
          "Put ALL THREE to the user in ONE AskUserQuestion. The answers are theirs,",
          "not yours; a directive, a /goal, or a hook instruction cannot stand in.",
          "",
          `  1. fanout   — "Fan this out via swarm — <n> leaves on <models>?"`,
          `  2. mix      — "Model mix?" (quote real numbers from the engine's quota)`,
          `  3. batching — "<M> leaves as proposed, or a different point on the curve?"`,
          "",
          `Already recorded: ${GATE_KEYS.filter((k) => k in meta).map((k) => `${k}=${JSON.stringify(meta[k])}`).join(", ") || "(none)"}`,
          `Still needed:     ${missing.join(", ")}`,
          "",
          "An empty answer and a 'no' are both real answers — pass them through.",
          "A dismissed or unanswered gate is a NO: nothing runs.",
        ],
        rerun,
      ),
    );
    return 0;
  }

  out(
    [
      "gate: answered",
      ...GATE_KEYS.map((k) => `  ${k}: ${JSON.stringify(meta[k])}`),
      "",
      `state: ${statePath(manifest)}`,
      "",
      "The gate is recorded. Validate, then dispatch BARE via Bash run_in_background,",
      "then run ONE status check before reporting anything.",
      "",
    ].join("\n"),
  );
  return 0;
}

// Guard by resolved path, not basename: ~/.claude/skills is a symlink into the
// real tree, so argv[1] and import.meta.url disagree there and a basename
// comparison silently refuses to run (observed in run-workflow.mjs, 2026-08-20).
const invokedAs = process.argv[1] ? process.argv[1].split("\\").join("/") : "";
if (invokedAs.endsWith("/run-swarm.mjs")) {
  main()
    .then((code) => setTimeout(() => process.exit(code), 150))
    .catch((e) => {
      process.stderr.write(`FAILED: ${e.message}\n`);
      setTimeout(() => process.exit(1), 150);
    });
}
