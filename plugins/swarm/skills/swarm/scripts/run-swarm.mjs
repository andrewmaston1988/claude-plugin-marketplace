#!/usr/bin/env node
/**
 * Driver for the swarm skill's session-side sequence: records the gate answers,
 * which nothing else persists across compaction. It does not enforce consent —
 * the Bash hook covers one of three dispatch paths, so SKILL.md's gate prose
 * governs the rest.
 *
 * Exit modes: pause banner or needInput JSON (both 0), non-zero on failure.
 * Never exit 0 silently — a caller cannot tell that from success.
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
// manifest replays cache and exits in seconds, which is not a live run.
//
// Health comes from what the engine RAISES — quiet leaves and state tags — never
// from token magnitude, which is an accounting artefact on :cloud (no prompt-cache
// buckets, so every turn re-sends the transcript as fresh input).
const ATTENTION = ["failed", "rate-limited", "quota", "blocked"];

// The count is worth showing — agents should be able to read it. What fails is
// reading MAGNITUDE as health, so the number always arrives with the arithmetic
// that explains it. `anomalous` is deliberately never set from size: a runaway
// surfaces through timeoutMs or the citation check, not through a big number.
export function tokenNote({ input = 0, output = 0, cloud = true } = {}) {
  const m = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : `${Math.round(n / 1000)}k`);
  if (!cloud) {
    return {
      anomalous: false,
      text: `${m(input)} in / ${m(output)} out — a Claude leaf parks its re-sent prefix in cacheRead, which is excluded, so this is not comparable to a :cloud count`,
    };
  }
  const ratio = output > 0 ? Math.round(input / output) : null;
  return {
    anomalous: false,
    text:
      `${m(input)} in / ${m(output)} out` +
      (ratio ? ` (${ratio}x)` : "") +
      ` — output is the work; input is the transcript re-sent once per turn, ` +
      `uncached on :cloud. A 100-180x ratio is normal for a working agent.`,
  };
}

export function livenessVerdict({ states = [], skipped = 0, total = 0, quiet = [] } = {}) {
  const attention = ATTENTION.filter((s) => states.includes(s));
  const live = states.includes("running") || states.includes("retrying");
  if (live) {
    return { live: true, cacheReplay: false, attention, quiet, reason: "at least one leaf is running" };
  }
  const allSkipped = total > 0 && skipped === total;
  if (allSkipped) {
    return {
      live: false,
      cacheReplay: true,
      attention,
      quiet,
      reason: `cache replay — ${skipped}/${total} [skipped], nothing re-executed`,
    };
  }
  return { live: false, cacheReplay: false, attention, quiet, reason: "no leaf is running" };
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


// ── Reading a run's state ─────────────────────────────────────────────────────

// run.log is JSONL and tailable mid-run; each state change is { ts, id, state }.
// Parsing it beats parsing `status` output, which is rendered for a human.
export function readRunLog(resultsDir) {
  const p = join(resultsDir, "run.log");
  if (!existsSync(p)) return [];
  return readFileSync(p, "utf8")
    .split(/\r?\n/)
    .filter(Boolean)
    .map((l) => { try { return JSON.parse(l); } catch { return null; } })
    .filter(Boolean);
}

// Last state wins per leaf — a leaf moves pending -> running -> ok/failed.
export function leafStates(events) {
  const byId = new Map();
  for (const e of events) {
    if (e && e.id && e.state) byId.set(e.id, e.state);
  }
  return byId;
}

// The roster the liveness check needs, derived from the log.
export function rosterFrom(resultsDir, { now = Date.now(), quietMs = 60000 } = {}) {
  const events = readRunLog(resultsDir);
  const byId = leafStates(events);
  const states = [...byId.values()];
  const skipped = states.filter((v) => v === "skipped").length;

  // A running leaf that has emitted nothing for longer than the threshold is the
  // real stall indicator; the engine renders the same thing as `quiet <N>s`.
  const lastSeen = new Map();
  for (const e of events) {
    if (e && e.id && e.ts) lastSeen.set(e.id, Date.parse(e.ts));
  }
  const quiet = [];
  for (const [id, state] of byId) {
    if (state !== "running" && state !== "retrying") continue;
    const t = lastSeen.get(id);
    if (t && now - t > quietMs) quiet.push({ id, secs: Math.round((now - t) / 1000) });
  }

  // Live usage ticks: { ts, id, event: "tokens", tokens }. Last tick wins.
  const tokens = new Map();
  for (const e of events) {
    if (e && e.id && e.event === "tokens" && e.tokens) tokens.set(e.id, e.tokens);
  }
  return { states, skipped, total: states.length, byId, quiet, tokens };
}

// Render each leaf's usage with the arithmetic that makes it readable, so the
// number informs rather than alarms.
function tokenLines(roster) {
  const out = [];
  for (const [id, t] of roster.tokens ?? []) {
    const input = (t.input ?? 0) + (t.cacheCreation ?? 0);
    const note = tokenNote({ input, output: t.output ?? 0, cloud: t.cloud !== false });
    out.push(`  ${id}: ${note.text}`);
  }
  return out;
}

// ── Progress state ────────────────────────────────────────────────────────────

const STATE_DIR = join(process.env.SWARM_HOME || join(process.env.USERPROFILE || process.env.HOME || ".", ".swarm"), "driver");

// The shape-decision procedure lives in swarm:executing-swarms and is delivered by
// path, never summarised here — an inline copy would rot against the real one.
const STRATEGY_DOC = fileURLToPath(new URL("../../executing-swarms/SKILL.md", import.meta.url))
  .split("\\")
  .join("/");

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
  meta = recordGate(meta, "strategy", getFlag("strategy", argv));
  state.meta = meta;
  writeState(manifest, state, { dryRun });

  // The gate's three questions are unanswerable without a manifest and the
  // grouping arithmetic behind it. Route there first, once, rather than letting a
  // model invent a leaf count at the moment it is asked to justify one.
  if (!("strategy" in meta) && !gateAnswered(meta)) {
    const self = fileURLToPath(import.meta.url).split("\\").join("/");
    out(
      banner(
        "Strategy — decide the shape before the gate can be answered",
        [
          "The gate asks how many leaves, on which models, at which batching point.",
          "None of that is answerable from the request alone.",
          "",
          "READ THIS NOW — mandatory, in full:",
          `  ${STRATEGY_DOC}`,
          "",
          "It is a five-step procedure and every step produces an input the gate",
          "consumes: the grouping arithmetic (via Skill(swarm:orchestrating-agents),",
          "which it will send you to first), the contract frame, the placement",
          "digraph that yields the topology, one-manifest-vs-two-waves, and the",
          "hand-off to models, cost and validate.",
          "",
          "Then re-run with --strategy to confirm it is settled. Recorded once;",
          "you will not be asked again for this manifest.",
        ],
        `node "${self}" --manifest "${manifest}" --strategy done`,
      ),
    );
    return 0;
  }

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

  // --dispatch-output: hand the driver the engine's stdout so it captures the
  // results dir rather than letting anyone reconstruct one from the manifest stem.
  const dispatchOut = getFlag("dispatch-output", argv);
  if (dispatchOut !== undefined) {
    const captured = captureResultsDir(
      existsSync(dispatchOut) ? readFileSync(dispatchOut, "utf8") : dispatchOut,
    );
    if (!captured) {
      process.stderr.write(
        "FAILED: no 'resultsDir:' line in the dispatch output.\n" +
          "Copy the engine's printed line verbatim; never reconstruct the path.\n",
      );
      return 1;
    }
    state.resultsDir = captured;
    writeState(manifest, state, { dryRun });
  }

  const resultsDir = getFlag("results-dir", argv) || state.resultsDir;

  // The mandatory liveness check: ONE look, and a cache replay is not a live run.
  if (argv.includes("--check-liveness")) {
    if (!resultsDir) {
      out(needInput("results-dir", "Pass --dispatch-output <file|text> first, or --results-dir <path>"));
      return 0;
    }
    const roster = rosterFrom(resultsDir);
    const v = livenessVerdict(roster);
    state.liveness = { checkedAt: new Date().toISOString(), ...v };
    writeState(manifest, state, { dryRun });
    out(
      [
        `liveness: ${v.live ? "LIVE" : "NOT LIVE"}`,
        `  ${v.reason}`,
        `  leaves: ${roster.total}` + (roster.skipped ? ` (${roster.skipped} skipped)` : ""),
        ...(v.attention.length ? [`  needs attention: ${v.attention.join(", ")}`] : []),
        ...(v.quiet.length
          ? v.quiet.map((q) => `  quiet: ${q.id} — no event for ${q.secs}s`)
          : []),
        ...tokenLines(roster),
        ...(v.live && !v.attention.length && !v.quiet.length
          ? ["  nothing to act on"]
          : []),
        "",
        v.cacheReplay
          ? "This run replayed cache — NOTHING RE-EXECUTED. Do not report it as running."
          : v.live
            ? "Hands off until the completion notification. One check is all you get."
            : "No leaf is running. Check the dispatch before reporting anything.",
        "",
      ].join("\n"),
    );
    return 0;
  }

  // Failure routing, once a run has ended badly.
  if (argv.includes("--route-failure")) {
    const r = routeFailure({
      timedOut: argv.includes("--timed-out"),
      erroredOnce: argv.includes("--errored"),
      committedSince: argv.includes("--committed-since"),
      quota: argv.includes("--quota"),
      attempts: Number(getFlag("attempts", argv) || 1),
    });
    out(
      [
        `route: ${r.action}${r.ask ? " (ASK the user)" : " (no ask)"}`,
        `  ${r.reason}`,
        "",
        ...(r.ask ? ["Offer via AskUserQuestion:", ...r.options.map((o) => `  - ${o}`), ""] : []),
      ].join("\n"),
    );
    return 0;
  }

  const est = getFlag("inline-lines", argv);
  const estimate =
    est === undefined
      ? null
      : inlineEstimate({ totalLines: Number(est) || 0, comparable: !argv.includes("--not-comparable") });

  out(
    [
      "gate: answered",
      ...GATE_KEYS.map((k) => `  ${k}: ${JSON.stringify(meta[k])}`),
      ...(estimate ? ["", estimate.text] : []),
      ...(resultsDir ? ["", `resultsDir: ${resultsDir}`] : []),
      "",
      `state: ${statePath(manifest)}`,
      "",
      "The gate is recorded. Validate, then dispatch BARE via Bash run_in_background.",
      "Then hand the dispatch output back:",
      `  node "${fileURLToPath(import.meta.url).split("\\").join("/")}" --manifest "${manifest}" --dispatch-output <file> --check-liveness`,
      "",
    ].join("\n"),
  );
  return 0;
}

// Guard by resolved path, not basename: a symlinked skills dir makes argv[1]
// and import.meta.url disagree, and a basename comparison then silently
// refuses to run.
const invokedAs = process.argv[1] ? process.argv[1].split("\\").join("/") : "";
if (invokedAs.endsWith("/run-swarm.mjs")) {
  main()
    .then((code) => setTimeout(() => process.exit(code), 150))
    .catch((e) => {
      process.stderr.write(`FAILED: ${e.message}\n`);
      setTimeout(() => process.exit(1), 150);
    });
}
