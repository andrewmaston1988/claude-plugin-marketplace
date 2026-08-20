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
import { join, dirname, resolve } from "node:path";
import { spawnSync } from "node:child_process";
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

// The Iron Law's post-dispatch discipline, as the task list the driver OWNS. It
// prints these as [TASK_CREATE] lines at the gate-answered moment; SKILL.md tells
// the model to mirror them, not to author its own from prose.
export const IRON_LAW_TASKS = [
  "offer-gate answered",
  "one liveness check (--check-liveness), then hands-off",
  "recover a bad leaf by re-dispatch, never kill/delete",
];
export function taskLines(items = IRON_LAW_TASKS) {
  return items.map((t) => `[TASK_CREATE] ${t}`);
}

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

// ── The driver AUTHORS the graph — the model supplies values, not structure ───
// Because the script emits the node list, the model cannot route a required node
// out — the failure the whole rewrite exists to kill. The answer fields are the
// ones `parseShape` accepts and `SHAPE_EXAMPLE` shows; do not restate them here.
export function buildManifest(answers = {}) {
  const tasks = [];

  if (answers.itemSource) {
    // Runtime list: a discovery task feeding a single forEach leaf. Never expand
    // the list into N static siblings — that is the S5 failure, prevented here at
    // emission rather than caught at validate.
    const findId = "find";
    tasks.push({
      id: findId,
      model: answers.itemSource.model,
      prompt: answers.itemSource.findPrompt,
      returns: { type: "array", items: { type: "string" } },
    });
    tasks.push({
      id: "each",
      model: answers.perItem.model,
      after: [findId],
      forEach: { from: findId, maxItems: answers.perItem.maxItems },
      prompt: answers.perItem.prompt,
    });
  } else if (Array.isArray(answers.items)) {
    const buildsOn = new Set(answers.items.map((it) => it.buildsOnCommitsOf).filter(Boolean));
    for (const it of answers.items) {
      // Every engine field passes through untouched — one blob keeps the engine's
      // full surface. Only the shape-level keys the driver interprets are dropped.
      const { buildsOnCommitsOf, ...task } = it;
      if (buildsOn.has(it.id)) {
        task.isolation = { worktree: it.id };
        task.allowedTools = "Read,Grep,Glob,Write,Edit";
      }
      if (it.buildsOnCommitsOf) {
        // Depends on another's EDITS (commits), not just its output text: seed a
        // private tree from that task's branch, and add the after-edge.
        task.after = [it.buildsOnCommitsOf];
        task.isolation = { worktree: it.id, from: it.buildsOnCommitsOf };
      }
      tasks.push(task);
    }
  }

  // A COMBINED output forces a node consuming every leaf — the model has no
  // opportunity to omit it. HOW it combines depends on what the leaves produce:
  //   - text results (docs, findings): a SYNTHESIS leaf that reads {{result:}} of
  //     each and writes the one artifact. This is the common case (E2).
  //   - commits (code edits in private worktrees): an agentless `integrate` node
  //     that merges the branches. Requires the leaves to isolate + write.
  // mode defaults to "results" (text); "commits" selects integrate.
  if (answers.combinedOutput) {
    // What the consuming node reads is WORK, never inputs. On a runtime list the
    // finder returns a file list and the forEach leaf does the work, so the
    // consumer must wait on the leaf — wiring it to the finder would synthesise
    // from filenames and silently ignore every result.
    const leafIds = answers.itemSource
      ? tasks.filter((t) => t.forEach).map((t) => t.id)
      : tasks.filter((t) => !t.integrate && !t.forEach && !t.compute).map((t) => t.id);
    if (leafIds.length) {
      const co = answers.combinedOutput;
      const id = co.id || (co.mode === "commits" ? "integrate" : "assemble");
      if (co.mode === "commits") {
        // Every merged leaf needs its own worktree so a branch exists to merge.
        for (const t of tasks) if (leafIds.includes(t.id)) { t.isolation = { ...(t.isolation || {}), worktree: t.id }; t.allowedTools = "Read,Grep,Glob,Write,Edit"; }
        tasks.push({ id, after: [...leafIds], integrate: { into: co.into, from: leafIds } });
      } else {
        // Synthesis leaf: reads each leaf's result text and writes the artifact.
        const refs = leafIds.map((lid) => `{{result:${lid}}}`).join("\n");
        tasks.push({
          id,
          model: co.model || tasks.find((t) => leafIds.includes(t.id))?.model,
          after: [...leafIds],
          prompt:
            `Assemble a single ${co.into} from these leaf results, reconciling ` +
            `cross-cutting terms so they are used consistently across all of them:\n${refs}` +
            (co.label ? `\n\nGoal: ${co.label}` : ""),
        });
      }
    }
  }

  return { tasks };
}

// ── The step machine — guards on observable reality, never the marker ─────────
// The driver's canonical step list. Each run re-reads the world, finds the first
// step whose EFFECT is absent, and either performs it (author, validate) or pauses
// for the one judgement it needs (shape values, gate consent, dispatch, liveness).
export const DRIVER_STEPS = ["read-strategy", "shape", "author", "validate", "gate", "dispatch", "liveness"];

// Compare the WHOLE emitted document, digest included — a shape edit that touches
// only `digest` must still rewrite the manifest, or the stale block ships forever.
function sameTasks(a, b) {
  const key = (m) => JSON.stringify({ tasks: m?.tasks ?? null, digest: m?.digest ?? null });
  return key(a) === key(b);
}

// The world: { meta, shape, manifestFile, manifestOnDisk, resultsDir, liveness }.
// `author` is done only when the file on disk holds exactly the graph the shape
// builds — a file missing the consuming node is rewritten, never trusted.
export function stepDone(step, world = {}) {
  const meta = world.meta || {};
  if (step === "read-strategy") return "read-strategy" in meta;
  if (step === "shape") return !!world.shape;
  if (step === "author") {
    return !!world.shape && !!world.manifestOnDisk && sameTasks(world.manifestOnDisk, buildManifest(world.shape));
  }
  if (step === "validate") {
    const v = meta.validate;
    return !!world.manifestOnDisk && !!v && v.ok === true && v.file === world.manifestFile;
  }
  if (step === "gate") return gateAnswered(meta);
  if (step === "dispatch") return !!world.resultsDir;
  if (step === "liveness") return !!world.liveness;
  return false; // an unrecognised step is never assumed done
}

export function firstIncompleteStep(world) {
  for (const step of DRIVER_STEPS) if (!stepDone(step, world)) return step;
  return null;
}

// The harness task list is a projection of the driver's state: seed every step
// once, then emit only the statuses that changed since the last run.
export function stepTaskLines({ previous = null, current = {} } = {}) {
  const lines = [];
  if (!previous) lines.push(...DRIVER_STEPS.map((s) => `[TASK_CREATE] swarm: ${s}`));
  DRIVER_STEPS.forEach((s, i) => {
    const st = current[s];
    if (st && st !== (previous || {})[s]) lines.push(`[TASK_UPDATE] ${i} ${st}`);
  });
  return lines;
}

export function taskProjection(world) {
  const first = firstIncompleteStep(world);
  const out = {};
  for (const s of DRIVER_STEPS) {
    if (stepDone(s, world)) out[s] = "completed";
    else if (s === first) out[s] = "in_progress";
  }
  return out;
}

// The shape file is the model's ONLY authoring surface: values, never nodes.
// Errors name the field and show a correct example, so one round-trip reaches green.
export const SHAPE_EXAMPLE = {
  items: [
    { id: "ref-scheduler", prompt: "Write a one-page API reference for src/scheduler.mjs", model: "glm-5.2:cloud" },
    { id: "ref-manifest", prompt: "Write a one-page API reference for src/manifest.mjs", model: "glm-5.2:cloud" },
  ],
  combinedOutput: { into: "REFERENCE.md", label: "one document, consistent terms", model: "glm-5.2:cloud" },
};
export function parseShape(text) {
  let shape;
  try { shape = JSON.parse(text); } catch (e) { return { error: `shape file is not valid JSON: ${e.message}` }; }
  if (!shape || typeof shape !== "object") return { error: "shape file must be a JSON object" };
  if (shape.itemSource) {
    if (!shape.itemSource.findPrompt || !shape.itemSource.model) return { error: "itemSource needs { findPrompt, model }" };
    if (!shape.perItem || !shape.perItem.prompt || !shape.perItem.model || !shape.perItem.maxItems) {
      return { error: "a runtime list needs perItem: { prompt (use {{item}}), model, maxItems }" };
    }
  } else if (Array.isArray(shape.items)) {
    if (!shape.items.length) return { error: "items is empty — list at least one { id, prompt, model }" };
    for (const it of shape.items) {
      if (!it.id || !it.prompt || !it.model) return { error: `every item needs { id, prompt, model }; got ${JSON.stringify(it)}` };
    }
  } else {
    return { error: "shape needs either items: [...] (a known list) or itemSource + perItem (a list discovered at runtime)" };
  }
  if (shape.combinedOutput && !shape.combinedOutput.into) {
    return { error: 'combinedOutput needs { into: "<the one artifact>" } (and mode: "commits" when leaves commit code)' };
  }
  return { shape };
}

// ── The validate gate — the offer gate guards on the WORLD, not the marker ────
// A recorded gate answer is not consent to spend if no VALIDATED manifest file
// exists: the cost line the gate quotes must be the engine's real estimate, not
// a number a session computed by hand. `--manifest` is only a state key, so the
// driver cannot assume a file behind it — the model authors the JSON, runs the
// engine's `validate`, and hands the result back with --validate-output. Until
// that lands, the offer gate is unreachable.

// Parse the engine's `validate` stdout: OK is the "manifest OK" line, and the
// estimate is the "estimated ~…" line it prints for the gate to quote verbatim.
export function parseValidateOutput(stdout = "") {
  const text = String(stdout);
  const ok = /^manifest OK\b/m.test(text);
  const m = text.match(/^estimated .*/m);
  return { ok, estimate: m ? m[0].trim() : null };
}

// Store a validation result under meta.validate — presence + ok is what the gate
// reads, and the estimate is what it quotes.
export function recordValidation(meta = {}, { ok, estimate = null, file = null } = {}) {
  return { ...meta, validate: { ok: !!ok, estimate, file } };
}

// The gate verdict: passes ONLY when a successful validation is recorded. Returns
// the estimate line so the offer gate can quote the real number.
// The gates chain backwards: each precondition is only reachable once every prior
// one is satisfied. read-strategy -> strategy -> validate -> offer. A later gate's
// input (a --validate-output) must be IGNORED until the earlier gates are answered,
// so a session cannot bank validation before it has read the strategy and placed
// the shape. `priorGatesMet` is that predicate.
export const GATE_CHAIN = ["read-strategy", "shape"];
export function priorGatesMet(meta = {}) {
  return GATE_CHAIN.every((k) => k in meta);
}

export function validateGate({ meta = {} } = {}) {
  const v = meta.validate;
  if (!v || !v.ok) {
    return {
      passed: false,
      reason:
        "No validated manifest. The driver builds the manifest from the shape file and runs " +
        "the engine's validate itself; the gate quotes that estimate — a hand-computed cost is not consent.",
    };
  }
  return { passed: true, estimate: v.estimate || null };
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

// The strategy procedure lives in one file and is delivered by path, never
// summarised here — an inline copy would rot against the real one.
const STRATEGY_DOC = fileURLToPath(new URL("../execution-strategy.md", import.meta.url))
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
  const self = fileURLToPath(import.meta.url).split("\\").join("/");
  const dryRun = argv.includes("--dry-run");

  // The read pause sits BEFORE --manifest: a session names a manifest once it
  // has drafted one, by which point the pause can only rubber-stamp the shape.
  const manifest = getFlag("manifest", argv);
  const recorded = (manifest && readState(manifest)?.meta) || {};
  if (getFlag("read-strategy", argv) === undefined && !("read-strategy" in recorded)) {
    out(
      banner(
        "Read the execution strategy — before anything else",
        [
          "The STRATEGY is the manifest's SHAPE: which tasks exist, what each one",
          "must wait for, and therefore how wide the graph is at each step. You do",
          "not pick a shape — you place each task by asking what must FINISH before",
          "it can start, and the shape falls out. That procedure, the digraph that",
          "drives it, and where the manifest's edge sits are in this file:",
          "",
          `  ${STRATEGY_DOC}`,
          "",
          "Open it with the Read tool. Not a summary, not a pattern you have seen",
          "before, not this driver's paraphrase — ~2k tokens. A manifest drafted",
          "from recall is how a reconcile step ends up outside the graph.",
          "",
          "Nothing else is asked at this pause. Read it, then re-run.",
        ],
        `node "${self}" --manifest <name-this-run> --read-strategy done`,
      ),
    );
    return 0;
  }

  if (!manifest) {
    out(needInput("manifest", "Name this run: --manifest <name>. The file need not exist yet."));
    return 0;
  }

  const state = readState(manifest) || { manifest, meta: {} };
  const previousTasks = state.tasks || null;
  let meta = state.meta || {};
  meta = recordGate(meta, "read-strategy", getFlag("read-strategy", argv));

  // --shape-file: the model's only authoring surface. Recorded by absolute path;
  // the WORLD below re-reads it every run, so an edited shape rebuilds the graph.
  const shapeFlag = getFlag("shape-file", argv);
  if (shapeFlag !== undefined) meta = recordGate(meta, "shape", resolve(shapeFlag).split("\\").join("/"));
  state.meta = meta;

  const manifestFile = (meta.manifestFile || statePath(manifest).replace(/\.json$/, ".manifest.json")).split("\\").join("/");
  const engine = fileURLToPath(new URL("../../../scripts/swarm.mjs", import.meta.url)).split("\\").join("/");

  // Observe the world for every guarded step.
  let shapeError = null;
  const observe = () => {
    let shape = null;
    if (meta.shape && existsSync(meta.shape)) {
      const parsed = parseShape(readFileSync(meta.shape, "utf8"));
      if (parsed.shape) shape = parsed.shape; else shapeError = parsed.error;
    }
    let manifestOnDisk = null;
    if (existsSync(manifestFile)) {
      try { manifestOnDisk = JSON.parse(readFileSync(manifestFile, "utf8")); } catch { manifestOnDisk = null; }
    }
    return { meta, shape, manifestFile, manifestOnDisk, resultsDir: getFlag("results-dir", argv) || state.resultsDir, liveness: state.liveness };
  };

  const lines = [];
  const finish = (code = 0) => {
    const world = observe();
    const current = taskProjection(world);
    const tasks = stepTaskLines({ previous: previousTasks, current });
    if (!dryRun) { state.tasks = current; writeState(manifest, state); }
    if (tasks.length) out(["Mirror into the harness task list:", ...tasks.map((l) => `  ${l}`), ""].join("\n"));
    out(lines.join("\n"));
    return code;
  };

  // Failure routing is askable at any point once a run has ended badly.
  if (argv.includes("--route-failure")) {
    const r = routeFailure({
      timedOut: argv.includes("--timed-out"),
      erroredOnce: argv.includes("--errored"),
      committedSince: argv.includes("--committed-since"),
      quota: argv.includes("--quota"),
      attempts: Number(getFlag("attempts", argv) || 1),
    });
    lines.push(
      `route: ${r.action}${r.ask ? " (ASK the user)" : " (no ask)"}`,
      `  ${r.reason}`,
      "",
      ...(r.ask ? ["Offer via AskUserQuestion:", ...r.options.map((o) => `  - ${o}`), ""] : []),
    );
    return finish(0);
  }

  // --dispatch-output: the engine's stdout, so the driver captures the results
  // dir rather than letting anyone reconstruct one from the manifest stem.
  const dispatchOut = getFlag("dispatch-output", argv);
  if (dispatchOut !== undefined && gateAnswered(meta)) {
    const captured = captureResultsDir(existsSync(dispatchOut) ? readFileSync(dispatchOut, "utf8") : dispatchOut);
    if (!captured) {
      process.stderr.write(
        "FAILED: no 'resultsDir:' line in the dispatch output.\n" +
          "Copy the engine's printed line verbatim; never reconstruct the path.\n",
      );
      return 1;
    }
    state.resultsDir = captured;
  }

  // The loop: perform what the script can, pause for what it cannot.
  for (;;) {
    const world = observe();
    const step = firstIncompleteStep(world);

    if (step === "shape") {
      lines.push(
        banner(
          "Shape — supply the VALUES; the driver builds the graph",
          [
            "You do not write the tasks array. Invoke Skill(swarm:orchestrating-agents)",
            "for the grouping, then write ONE JSON file answering these questions:",
            "",
            "  items          — the known list: [{ id, prompt, model, after?, buildsOnCommitsOf? }]",
            "                   after: ids whose OUTPUT this one reads ({{result:<id>}} in its prompt)",
            "                   buildsOnCommitsOf: the id whose COMMITS this one edits on top of",
            "                   any other engine field (allowedTools, effort, cwd, timeoutMs, returns,",
            "                   when, fallbackModel, outputDir) passes through as written",
            "  itemSource     — OR, a list only known at runtime: { findPrompt, model }",
            "  perItem        — with itemSource: { prompt (use {{item}}), model, maxItems }",
            "  combinedOutput — when the request names ONE artifact assembled from the",
            '                   leaves: { into, label?, model?, mode?: "commits" }.',
            "                   The driver then EMITS the consuming node; it cannot be left out.",
            "  digest         — optional: the engine's digest block (instructions, model)",
            "",
            "Example:",
            ...JSON.stringify(SHAPE_EXAMPLE, null, 2).split("\n").map((l) => `  ${l}`),
            "",
            ...(shapeError ? [`Last shape file rejected: ${shapeError}`, `  (${meta.shape})`, ""] : []),
            `Run \`node "${engine}" models\` for launchable model names.`,
          ],
          `node "${self}" --manifest "${manifest}" --shape-file <path>`,
        ),
      );
      return finish(0);
    }

    if (step === "author") {
      const built = { ...buildManifest(world.shape), ...(world.shape.digest ? { digest: world.shape.digest } : {}) };
      if (dryRun) {
        lines.push(`dry-run: would write ${manifestFile} (${built.tasks.length} task(s): ${built.tasks.map((t) => t.id).join(", ")})`, "");
        lines.push("dry-run: would run validate on it, then reach the offer gate.", "");
        return finish(0);
      }
      mkdirSync(dirname(manifestFile), { recursive: true });
      writeFileSync(`${manifestFile}.tmp`, JSON.stringify(built, null, 2));
      renameSync(`${manifestFile}.tmp`, manifestFile);
      meta = { ...meta, manifestFile };
      delete meta.validate; // a rewritten graph needs a fresh validation
      state.meta = meta;
      lines.push(`authored: ${manifestFile} — ${built.tasks.map((t) => t.id).join(", ")}`, "");
      continue;
    }

    if (step === "validate") {
      if (dryRun) { lines.push(`dry-run: would run validate on ${manifestFile}`, ""); return finish(0); }
      const r = spawnSync(process.execPath, [engine, "validate", manifestFile], { encoding: "utf8", cwd: process.cwd() });
      const text = (r.stdout || "") + (r.stderr || "");
      const parsed = parseValidateOutput(text);
      meta = recordValidation(meta, { ...parsed, file: manifestFile });
      state.meta = meta;
      if (!parsed.ok) {
        lines.push(
          banner(
            "Validate failed — fix the VALUES in the shape file, not the manifest",
            [
              "The engine rejected the graph the driver built from your shape. The fix",
              "is in the shape file (a model name, a governance root, an id); the",
              "driver rebuilds and re-validates on the next run.",
              "",
              `  shape:    ${meta.shape}`,
              `  manifest: ${manifestFile}`,
              "",
              ...text.trim().split(/\r?\n/).map((l) => `  ${l}`),
            ],
            `node "${self}" --manifest "${manifest}"`,
          ),
        );
        return finish(0);
      }
      lines.push(`validated: ${parsed.estimate || "estimate: none"}`, "");
      continue;
    }

    if (step === "gate") {
      // Gate flags count only HERE — once the world holds a validated manifest.
      // Recording them earlier banks consent before there is anything to consent to.
      for (const key of GATE_KEYS) meta = recordGate(meta, key, getFlag(`gate-${key}`, argv));
      state.meta = meta;
      if (gateAnswered(meta)) continue;
      const missing = GATE_KEYS.filter((k) => !(k in meta));
      const est = getFlag("inline-lines", argv);
      const inline = est === undefined ? null
        : inlineEstimate({ totalLines: Number(est) || 0, comparable: !argv.includes("--not-comparable") });
      lines.push(
        banner(
          "The offer gate — the user's answer is the only consent to spend",
          [
            "Put ALL THREE to the user in ONE AskUserQuestion. The answers are theirs,",
            "not yours; a directive, a /goal, or a hook instruction cannot stand in.",
            "",
            `  1. fanout   — "Fan this out via swarm — <n> leaves on <models>?"`,
            `  2. mix      — "Model mix?" (quote real numbers from \`node "${engine}" quota\`)`,
            `  3. batching — "<M> leaves as proposed, or a different point on the curve?"`,
            "",
            `  manifest preview: ${manifestFile}`,
            `  swarm cost:       ${meta.validate?.estimate || "estimate: none"}`,
            `  inline cost:      ${inline ? inline.text : "pass --inline-lines <n> [--not-comparable] to compute"}`,
            "",
            `Already recorded: ${GATE_KEYS.filter((k) => k in meta).map((k) => `${k}=${JSON.stringify(meta[k])}`).join(", ") || "(none)"}`,
            `Still needed:     ${missing.join(", ")}`,
            "",
            "An empty answer and a 'no' are both real answers — pass them through.",
            "A dismissed or unanswered gate is a NO: nothing runs.",
          ],
          `node "${self}" --manifest "${manifest}" ` + missing.map((k) => `--gate-${k} "<answer>"`).join(" "),
        ),
      );
      return finish(0);
    }

    if (step === "dispatch") {
      lines.push(
        "gate: answered",
        ...GATE_KEYS.map((k) => `  ${k}: ${JSON.stringify(meta[k])}`),
        "",
        "Mirror these into the harness task list — one TaskCreate each:",
        ...taskLines().map((l) => `  ${l}`),
        "",
        "Dispatch BARE via Bash run_in_background — no pipe, filter, or redirect:",
        `  node "${engine}" run "${manifestFile}"`,
        "",
        "Then hand the engine's output back (it captures resultsDir and runs the one liveness check):",
        `  node "${self}" --manifest "${manifest}" --dispatch-output <file> --check-liveness`,
        "",
      );
      return finish(0);
    }

    if (step === "liveness") {
      if (!argv.includes("--check-liveness")) {
        lines.push(`resultsDir: ${world.resultsDir}`, "", "Run the ONE liveness check:", `  node "${self}" --manifest "${manifest}" --check-liveness`, "");
        return finish(0);
      }
      const roster = rosterFrom(world.resultsDir);
      const v = livenessVerdict(roster);
      state.liveness = { checkedAt: new Date().toISOString(), ...v };
      lines.push(
        `liveness: ${v.live ? "LIVE" : "NOT LIVE"}`,
        `  ${v.reason}`,
        `  leaves: ${roster.total}` + (roster.skipped ? ` (${roster.skipped} skipped)` : ""),
        ...(v.attention.length ? [`  needs attention: ${v.attention.join(", ")}`] : []),
        ...v.quiet.map((q) => `  quiet: ${q.id} — no event for ${q.secs}s`),
        ...tokenLines(roster),
        ...(v.live && !v.attention.length && !v.quiet.length ? ["  nothing to act on"] : []),
        "",
        v.cacheReplay
          ? "This run replayed cache — NOTHING RE-EXECUTED. Do not report it as running."
          : v.live
            ? "Hands off until the completion notification. One check is all you get."
            : "No leaf is running. Check the dispatch before reporting anything.",
        "",
      );
      return finish(0);
    }

    // null: every step's effect is present.
    lines.push("swarm: all driver steps complete — hands off until the completion notification.", `state: ${statePath(manifest)}`, "");
    return finish(0);
  }
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
