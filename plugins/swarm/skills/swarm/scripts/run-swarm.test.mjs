// run-swarm.test.mjs — driver contract, gate persistence, and the computed decisions.
//
// The driver owns the SESSION-side sequence: gate answered -> validated ->
// dispatched -> one liveness check -> digest read. The engine already resumes
// (src/scheduler.mjs is a DAG state machine); nothing here touches it.
import { test } from "node:test";
import { equal, deepEqual, ok, match } from "node:assert/strict";
import {
  banner,
  needInput,
  GATE_KEYS,
  gateAnswered,
  recordGate,
  inlineEstimate,
  livenessVerdict,
  routeFailure,
  captureResultsDir,
  leafStates,
  rosterFrom,
  readRunLog,
  tokenNote,
} from "./run-swarm.mjs";

// ── Exit-mode contract ───────────────────────────────────────────────────────
// A driver must never exit 0 with no output: a caller branching on the exit
// modes cannot tell a silent success from a silent failure.

test("banner: a pause is never silent and carries the re-run command", () => {
  const out = banner("Gate", ["1. Ask"], "node run-swarm.mjs --gate-fanout yes");
  match(out, /PAUSE: Gate/);
  match(out, /RE-RUN EXACTLY/);
  match(out, /--gate-fanout yes/);
  ok(out.trim().length > 0);
});

test("needInput: one line of parseable JSON with a hint", () => {
  const out = needInput("manifest", "Which manifest?");
  equal(out.endsWith("\n"), true);
  equal(out.slice(0, -1).includes("\n"), false);
  const parsed = JSON.parse(out);
  equal(parsed.error, "missing_required_field");
  equal(parsed.field, "manifest");
  ok(String(parsed.hint ?? "").length > 0);
});

// ── Gate answers: presence, not truthiness ★ ─────────────────────────────────
// The known defect in run-workflow.mjs: an empty --plans-line is rejected because
// the check is `if (!state.meta[k])` rather than `if (k in state.meta)`, so the
// honest answer is unreachable and the pause loops forever. Do not copy it.

test("gateAnswered: false until all three keys are present", () => {
  equal(gateAnswered({}), false);
  equal(gateAnswered({ fanout: "yes" }), false);
  equal(gateAnswered({ fanout: "yes", mix: "as drafted" }), false);
  equal(gateAnswered({ fanout: "yes", mix: "as drafted", batching: "as proposed" }), true);
});

test("gateAnswered: an EMPTY answer is a real answer ★", () => {
  const meta = { fanout: "", mix: "", batching: "" };
  equal(gateAnswered(meta), true);
});

test("gateAnswered: a rejection is recorded, not treated as unanswered", () => {
  const meta = { fanout: "no", mix: "no", batching: "no" };
  equal(gateAnswered(meta), true);
});

test("recordGate: stores an empty string rather than dropping the key", () => {
  const meta = recordGate({}, "fanout", "");
  ok("fanout" in meta);
  equal(meta.fanout, "");
});

test("recordGate: does not clobber an existing answer with undefined", () => {
  const meta = recordGate({ fanout: "yes" }, "fanout", undefined);
  equal(meta.fanout, "yes");
});

test("GATE_KEYS: exactly the three questions the skill poses", () => {
  deepEqual([...GATE_KEYS].sort(), ["batching", "fanout", "mix"]);
});

// ── Inline-cost arithmetic ───────────────────────────────────────────────────
// The skill states the formula (total lines x ~10) and that `none` on a cold
// corpus is itself the honest answer. The driver must never invent a number.

test("inlineEstimate: lines x 10", () => {
  equal(inlineEstimate({ totalLines: 5000 }).tokens, 50000);
});

test("inlineEstimate: renders in k for readability", () => {
  match(inlineEstimate({ totalLines: 5000 }).text, /~50k tokens/);
});

test("inlineEstimate: no inline path is 'not comparable', never a number", () => {
  const e = inlineEstimate({ totalLines: 0, comparable: false });
  equal(e.tokens, null);
  match(e.text, /not comparable/);
});

test("inlineEstimate: a cold corpus is 'none', never 0", () => {
  const e = inlineEstimate({ totalLines: 0 });
  equal(e.tokens, null);
  match(e.text, /none/);
  ok(!/~0k/.test(e.text), "must not render a fabricated zero");
});

// ── Liveness: one check, and a cache replay is not success ───────────────────
// A session skipped this check and announced "Round 3 is running" when nothing
// was: a bare re-run of a complete manifest replays cache, 16/16 [skipped].

test("livenessVerdict: at least one running leaf is live", () => {
  const v = livenessVerdict({ states: ["running", "pending", "ok"] });
  equal(v.live, true);
});

test("livenessVerdict: all-skipped is a CACHE REPLAY, not a live run ★", () => {
  const v = livenessVerdict({ states: ["skipped", "skipped"], skipped: 2, total: 2 });
  equal(v.live, false);
  equal(v.cacheReplay, true);
  match(v.reason, /cache/i);
});

test("livenessVerdict: all-ok with nothing running is not live", () => {
  const v = livenessVerdict({ states: ["ok", "ok"] });
  equal(v.live, false);
});

test("livenessVerdict: an empty roster is not live", () => {
  const v = livenessVerdict({ states: [] });
  equal(v.live, false);
});

// ── Failure routing: a table over three booleans ─────────────────────────────
// The skill states commits-since-last-attempt is the discriminator, NOT attempt
// count alone: auto-resume converges for a leaf that made progress and loops for
// one that did not.

test("routeFailure: a plain timeout re-runs without asking", () => {
  const r = routeFailure({ timedOut: true, erroredOnce: false, committedSince: false, attempts: 1 });
  equal(r.action, "rerun");
  equal(r.ask, false);
});

test("routeFailure: an error gets ONE automatic retry, then asks", () => {
  equal(routeFailure({ timedOut: false, erroredOnce: true, attempts: 1 }).action, "retry");
  equal(routeFailure({ timedOut: false, erroredOnce: true, attempts: 2 }).ask, true);
});

test("routeFailure: a second timeout with nothing committed stops and asks ★", () => {
  const r = routeFailure({ timedOut: true, erroredOnce: false, committedSince: false, attempts: 2 });
  equal(r.ask, true);
  match(r.reason, /commit/i);
});

test("routeFailure: a second timeout that DID commit keeps going", () => {
  const r = routeFailure({ timedOut: true, erroredOnce: false, committedSince: true, attempts: 2 });
  equal(r.action, "rerun");
  equal(r.ask, false);
});

test("routeFailure: quota offers the recast-to-cloud option", () => {
  const r = routeFailure({ quota: true, attempts: 1 });
  ok(r.options.some((o) => /recast/i.test(o)));
});

// ── The results dir is copied, never reconstructed ───────────────────────────
// A session guessed a path from the manifest stem and published `p5-review-2`,
// a directory that has never existed.

test("captureResultsDir: reads the engine's printed line", () => {
  const out = "some preamble\nresultsDir: C:/runs/p5-review-1\nwatch: node x status C:/runs/p5-review-1\n";
  equal(captureResultsDir(out), "C:/runs/p5-review-1");
});

test("captureResultsDir: absent line yields null, never a guess ★", () => {
  equal(captureResultsDir("no such line here"), null);
});

test("captureResultsDir: takes the FIRST printed dir, not a later mention", () => {
  const out = "resultsDir: C:/runs/a-1\nchatter C:/runs/a-2\n";
  equal(captureResultsDir(out), "C:/runs/a-1");
});

// ── Reading the engine's real run.log ────────────────────────────────────────
// run.log is JSONL: { ts, id, state } per state change, plus event rows. Parsing
// it beats parsing `status`, which renders for a human tail.

test("leafStates: the LAST state per leaf wins", () => {
  const events = [
    { id: "a", state: "pending" },
    { id: "a", state: "running" },
    { id: "a", state: "ok" },
    { id: "b", state: "pending" },
  ];
  const m = leafStates(events);
  equal(m.get("a"), "ok");
  equal(m.get("b"), "pending");
});

test("leafStates: event rows without an id are ignored", () => {
  const m = leafStates([{ event: "run-start", tasks: [] }, { id: "a", state: "running" }]);
  equal(m.size, 1);
});

test("readRunLog: a missing run.log is empty, never a throw", () => {
  deepEqual(readRunLog("C:/definitely/not/a/run/dir"), []);
});

test("rosterFrom + livenessVerdict: a cache replay is detected end to end ★", async () => {
  const { mkdtempSync, writeFileSync: wf } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join: j } = await import("node:path");
  const dir = mkdtempSync(j(tmpdir(), "swarm-roster-"));
  wf(
    j(dir, "run.log"),
    [
      JSON.stringify({ event: "run-start", tasks: [{ id: "a" }, { id: "b" }] }),
      JSON.stringify({ id: "a", state: "skipped" }),
      JSON.stringify({ id: "b", state: "skipped" }),
    ].join("\n"),
  );
  const roster = rosterFrom(dir);
  equal(roster.total, 2);
  equal(roster.skipped, 2);
  const v = livenessVerdict(roster);
  equal(v.live, false);
  equal(v.cacheReplay, true);
});

test("rosterFrom + livenessVerdict: one running leaf reads as live", async () => {
  const { mkdtempSync, writeFileSync: wf } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join: j } = await import("node:path");
  const dir = mkdtempSync(j(tmpdir(), "swarm-roster-"));
  wf(
    j(dir, "run.log"),
    [
      JSON.stringify({ id: "a", state: "pending" }),
      JSON.stringify({ id: "a", state: "running" }),
    ].join("\n"),
  );
  equal(livenessVerdict(rosterFrom(dir)).live, true);
});

test("readRunLog: a malformed line is skipped, not fatal", async () => {
  const { mkdtempSync, writeFileSync: wf } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join: j } = await import("node:path");
  const dir = mkdtempSync(j(tmpdir(), "swarm-roster-"));
  wf(j(dir, "run.log"), '{"id":"a","state":"running"}\n{ broken\n');
  // A half-written final line is normal when tailing a live run.
  equal(readRunLog(dir).length, 1);
});

// ── The strategy pause teaches what the gate presumes ────────────────────────
// A pause must carry the state needed to decide, not just the question. The
// gate asks for a leaf count, a model mix, and a batching point; none is
// answerable without the grouping arithmetic orchestrating-agents owns.

test("the strategy pause delivers execution-strategy.md by resolvable path ★", async () => {
  const { readFileSync, existsSync } = await import("node:fs");
  const src = readFileSync(new URL("./run-swarm.mjs", import.meta.url), "utf8");
  // The pause hands over a path, not a summary — an inline copy would rot
  // against the real procedure. So the contract is: the file exists, and the
  // driver resolves it relative to itself rather than to the caller's cwd.
  ok(src.includes('new URL("../execution-strategy.md", import.meta.url)'),
     "must resolve the doc from import.meta.url, never process.cwd()");
  ok(existsSync(new URL("../execution-strategy.md", import.meta.url)),
     "the doc the pause points at must exist");
  ok(src.includes("swarm:orchestrating-agents"),
     "must still name the prerequisite skill — it gates step 1");
});

test("execution-strategy.md carries the procedure the gate presumes", async () => {
  const { readFileSync } = await import("node:fs");
  const doc = readFileSync(new URL("../execution-strategy.md", import.meta.url), "utf8");
  // Each is an input the gate's three questions consume.
  ok(/orchestrating-agents/.test(doc), "grouping arithmetic");
  ok(/goal · return_shape/.test(doc), "the contract frame");
  ok(/digraph/.test(doc), "the placement procedure");
  ok(/isolation\.from/.test(doc) && /integrate/.test(doc),
     "widening — the fields that make a second wave unnecessary");
  ok(/forEach/.test(doc) && /when/.test(doc) && /compute/.test(doc),
     "the runtime-expansion fields");
  ok(/not comparable/.test(doc), "both sides of the cost comparison");
});

test("strategy is recorded like a gate answer — presence, not truthiness", () => {
  const meta = recordGate({}, "strategy", "");
  ok("strategy" in meta, "an empty confirmation is still a confirmation");
});

// ── The verdict names the real signals, never raw magnitude ──────────────────
// Token counts on a :cloud leaf are an accounting artefact, and every recorded
// interference began with reading one as a health signal. The driver reports
// what the engine actually raises — quiet leaves and state tags — so there is no
// magnitude to misread.

test("livenessVerdict: surfaces quiet leaves, which ARE the stall signal", () => {
  const v = livenessVerdict({
    states: ["running", "running"],
    quiet: [{ id: "scan-a", secs: 90 }],
  });
  equal(v.live, true);
  deepEqual(v.quiet, [{ id: "scan-a", secs: 90 }]);
});

test("livenessVerdict: surfaces failure states by name", () => {
  const v = livenessVerdict({ states: ["running", "failed", "quota"] });
  deepEqual(v.attention.sort(), ["failed", "quota"]);
});

test("livenessVerdict: a healthy run reports nothing to act on", () => {
  const v = livenessVerdict({ states: ["running", "ok"] });
  deepEqual(v.attention, []);
  deepEqual(v.quiet, []);
});

// Agents need the number — the failure was reading MAGNITUDE as health. So the
// driver reports it with its interpretation attached: a :cloud leaf has no
// prompt-cache buckets, so every turn re-sends the transcript as fresh input and
// a 100-180x input/output ratio is the ordinary signature of a working agent.
test("tokenNote: a huge :cloud count with a working ratio reads as normal", () => {
  const n = tokenNote({ input: 21_000_000, output: 116_000, cloud: true });
  equal(n.anomalous, false);
  match(n.text, /180x|1[0-9][0-9]x/);
  match(n.text, /normal/i);
});

test("tokenNote: output is the work, input is the transcript re-sent", () => {
  const n = tokenNote({ input: 21_000_000, output: 116_000, cloud: true });
  match(n.text, /output/);
});

test("tokenNote: a Claude leaf's counts are not comparable to a :cloud leaf's", () => {
  const n = tokenNote({ input: 50_000, output: 10_000, cloud: false });
  match(n.text, /cacheRead|not comparable|Claude/i);
});

test("tokenNote: never calls a leaf sick from magnitude alone ★", () => {
  for (const input of [1e6, 5e6, 21e6, 50e6]) {
    equal(tokenNote({ input, output: input / 150, cloud: true }).anomalous, false);
  }
});

test("rosterFrom: a token tick is proof of life, so it clears quiet ★", async () => {
  const { mkdtempSync, writeFileSync: wf } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join: j } = await import("node:path");
  const dir = mkdtempSync(j(tmpdir(), "swarm-quiet-"));
  const old = new Date(Date.now() - 120000).toISOString();
  const now = new Date().toISOString();
  wf(
    j(dir, "run.log"),
    [
      JSON.stringify({ ts: old, id: "a", state: "running" }),
      JSON.stringify({ ts: old, id: "b", state: "running" }),
      // `a` is still emitting usage; `b` has said nothing for two minutes.
      JSON.stringify({ ts: now, id: "a", event: "tokens", tokens: { input: 9e6, output: 5e4 } }),
    ].join("\n"),
  );
  const r = rosterFrom(dir);
  deepEqual(r.quiet.map((q) => q.id), ["b"]);
});
