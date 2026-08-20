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
  validateGate,
  priorGatesMet,
  taskLines,
  IRON_LAW_TASKS,
  buildManifest,
  recordValidation,
  parseValidateOutput,
  DRIVER_STEPS,
  stepDone,
  firstIncompleteStep,
  stepTaskLines,
} from "./run-swarm.mjs";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync as wfs, readFileSync as rfs, existsSync as exs } from "node:fs";
import { tmpdir } from "node:os";
import { join as pj } from "node:path";
import { fileURLToPath } from "node:url";

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
  ok(/not[- ]comparable/.test(doc), "both sides of the cost comparison");
});

test("the shape answer is recorded like a gate answer — presence, not truthiness", () => {
  const meta = recordGate({}, "shape", "");
  ok("shape" in meta, "an empty confirmation is still a confirmation");
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

// ── The read is its own pause ────────────────────────────────────────────────
// One pause carrying five steps gets one "done" that attests to all of them, and
// the read is the step that gets skipped: two sessions drafted a manifest from a
// remembered pattern and confirmed the pause anyway. Splitting it means "done"
// can only mean the one thing the pause asked for.

test("the read pause asks for exactly one thing ★", async () => {
  const { readFileSync } = await import("node:fs");
  const src = readFileSync(new URL("./run-swarm.mjs", import.meta.url), "utf8");
  // Anchor on the guard, not the banner title — the title also appears in the
  // adjacent pause's text, and slicing from there yields an empty window that
  // passes every negative assertion for the wrong reason.
  const i = src.indexOf('!("read-strategy" in recorded)');
  ok(i > 0, "the read pause must exist");
  const body = src.slice(i, src.indexOf("return 0;", i));
  ok(/Nothing else is asked at this pause/.test(body),
     "must state that nothing else is asked, or it becomes a bundle again");
  ok(!/orchestrating-agents/.test(body),
     "must not smuggle the grouping step into the read pause");
});

test("the read gates the strategy pause, not the reverse", async () => {
  const { readFileSync } = await import("node:fs");
  const src = readFileSync(new URL("./run-swarm.mjs", import.meta.url), "utf8");
  ok(src.indexOf('"read-strategy" in recorded') < src.indexOf('getFlag("shape-file"'),
     "the read pause must be evaluated first");
});

test("read-strategy is recorded on presence, like every other answer", () => {
  const meta = recordGate({}, "read-strategy", "");
  ok("read-strategy" in meta);
});

// ── The offer gate is unreachable until validate passes on a real file ────────
// Observed live: a session reached the offer gate with --manifest <name> and NO
// JSON on disk, then answered the three questions from hand-computed numbers —
// validate never ran, so the cost line, schema/dep/governance checks, and the
// estimate were all fabricated. The gate must guard on the WORLD (a validated
// manifest file), not on the recorded answers alone.

test("validateGate: no manifest file recorded -> not passed, demands one", () => {
  const v = validateGate({ meta: {} });
  ok(!v.passed, "unvalidated meta must not pass the validate gate");
  ok(/authored|validate|manifest file/i.test(v.reason), v.reason);
});

test("validateGate: a stored validation with an estimate passes and carries the line", () => {
  const v = validateGate({ meta: { validate: { ok: true, estimate: "estimated ~1.58M tokens", file: "x.json" } } });
  ok(v.passed, "a recorded successful validation passes");
  equal(v.estimate, "estimated ~1.58M tokens");
});

test("validateGate: a stored FAILED validation does not pass", () => {
  const v = validateGate({ meta: { validate: { ok: false, file: "x.json" } } });
  ok(!v.passed, "a failed validation must not pass");
});

test("recordValidation: stores ok + estimate + file, keyed under meta.validate", () => {
  const meta = recordValidation({}, { ok: true, estimate: "estimated ~900k tokens", file: "plan.json" });
  equal(meta.validate.ok, true);
  equal(meta.validate.estimate, "estimated ~900k tokens");
  equal(meta.validate.file, "plan.json");
});

test("parseValidateOutput: pulls the estimate line and OK from engine stdout", () => {
  const stdout = "manifest OK: 2 task(s) + digest\nestimated ~1.58M tokens\nresultsDir: C:/x";
  const r = parseValidateOutput(stdout);
  equal(r.ok, true);
  equal(r.estimate, "estimated ~1.58M tokens");
});

test("parseValidateOutput: no 'manifest OK' line means not ok", () => {
  const r = parseValidateOutput("manifest validation failed:\n  - task 'a': bad");
  equal(r.ok, false);
});

// ── The gates chain backwards ────────────────────────────────────────────────
// validate must be unreachable until strategy is answered, which is unreachable
// until read-strategy is. Otherwise a session banks a --validate-output on the
// first call and satisfies the validate gate before ever reading the strategy.

test("priorGatesMet: false until BOTH read-strategy and shape are recorded", () => {
  ok(!priorGatesMet({}), "empty meta");
  ok(!priorGatesMet({ "read-strategy": "done" }), "read alone is not enough");
  ok(!priorGatesMet({ shape: "x.json" }), "shape alone is not enough");
  ok(priorGatesMet({ "read-strategy": "done", shape: "x.json" }), "both present");
});

// ── The driver owns the Iron Law task list ───────────────────────────────────
// Prose told the model to hand-author three TaskCreate items at dispatch; that is
// a parallel list the model improvises. The driver prints [TASK_CREATE] lines and
// the SKILL.md mirrors them (writing-skills+ Gate 1).

test("taskLines: emits one [TASK_CREATE] per Iron Law clause", () => {
  const lines = taskLines();
  equal(lines.length, IRON_LAW_TASKS.length);
  ok(lines.every((l) => l.startsWith("[TASK_CREATE] ")), lines.join("\n"));
  ok(lines.some((l) => /liveness/.test(l)), "names the liveness check");
  ok(lines.some((l) => /re-dispatch, never kill/.test(l)), "names the recovery rule");
});

// ── buildManifest emits the graph — the model supplies values, not structure ──
// The inversion: the driver constructs the tasks array, after-edges, and the
// integrate/forEach nodes from narrow answers. The model can no longer omit a
// required node because it never hand-authors the node list. Assertions pin the
// EMITTED GRAPH, never any narration.

test("buildManifest: a combined output forces an integrate node the model cannot drop ★", () => {
  const plan = buildManifest({
    items: [
      { id: "ref-a", prompt: "document module a", model: "glm-5.2:cloud" },
      { id: "ref-b", prompt: "document module b", model: "glm-5.2:cloud" },
      { id: "ref-c", prompt: "document module c", model: "glm-5.2:cloud" },
    ],
    combinedOutput: { into: "reference", label: "one REFERENCE.md, consistent terms" },
  });
  // A combined output must emit ONE node consuming every leaf — a synthesis leaf
  // (text results, the doc case) or an integrate node (commits). The model cannot
  // omit it either way. Here the leaves return text, so it is a synthesis leaf.
  const leafIds = ["ref-a", "ref-b", "ref-c"];
  const consumer = plan.tasks.find((x) => Array.isArray(x.after) && leafIds.every((l) => x.after.includes(l)));
  ok(consumer, "a node consuming all three leaves must be emitted: " + JSON.stringify(plan.tasks.map((x) => x.id)));
  ok(consumer.integrate || /result:ref-a/.test(consumer.prompt || ""), "it integrates the branches or synthesises the results");
});

test("buildManifest: no combined output -> parallel leaves, no integrate", () => {
  const plan = buildManifest({
    items: [
      { id: "a", prompt: "p", model: "haiku" },
      { id: "b", prompt: "p", model: "haiku" },
      { id: "c", prompt: "p", model: "haiku" },
    ],
  });
  ok(!plan.tasks.some((x) => x.integrate), "no integrate node when output is not combined");
  ok(plan.tasks.every((x) => !x.after || x.after.length === 0), "independent leaves have no after edges");
  equal(plan.tasks.length, 3);
});

test("buildManifest: a runtime list emits a find task + forEach, not N static siblings", () => {
  const plan = buildManifest({
    itemSource: { findPrompt: "list every .mjs importing child_process; return an array", model: "glm-5.2:cloud" },
    perItem: { prompt: "review {{item}} for unescaped args", model: "glm-5.2:cloud", maxItems: 30 },
  });
  const finder = plan.tasks.find((x) => /list every/.test(x.prompt || ""));
  ok(finder, "a discovery/find task is emitted");
  const fan = plan.tasks.find((x) => x.forEach);
  ok(fan, "a forEach leaf is emitted, not hand-expanded siblings");
  equal(fan.forEach.from, finder.id);
  equal(fan.forEach.maxItems, 30);
});

test("buildManifest: an item that builds on another's commits gets isolation.from", () => {
  const plan = buildManifest({
    items: [
      { id: "impl", prompt: "add the flag", model: "haiku" },
      { id: "test", prompt: "test the flag", model: "haiku", buildsOnCommitsOf: "impl" },
    ],
  });
  const test = plan.tasks.find((x) => x.id === "test");
  deepEqual(test.after, ["impl"]);
  ok(test.isolation && test.isolation.from === "impl", "builds-on-commits emits isolation.from, not just {{result}}");
});

test("buildManifest: a combined output over a RUNTIME list consumes the forEach leaf, not the finder ★", () => {
  // The finder returns a file LIST; `each` produces the actual work. A consuming
  // node wired to `find` would synthesise from filenames and silently ignore every
  // result — the routed-out-node failure this whole design exists to prevent.
  const plan = buildManifest({
    itemSource: { findPrompt: "list every module", model: "haiku" },
    perItem: { prompt: "document {{item}}", model: "haiku", maxItems: 10 },
    combinedOutput: { into: "REFERENCE.md" },
  });
  const consumer = plan.tasks.find((t) => t.id === "assemble" || t.integrate);
  ok(consumer, "a consuming node is emitted: " + JSON.stringify(plan.tasks.map((t) => t.id)));
  ok(consumer.after.includes("each"), "must wait on the forEach leaf: after=" + JSON.stringify(consumer.after));
  ok(!consumer.after.includes("find"), "must NOT consume the finder's raw list: after=" + JSON.stringify(consumer.after));
  ok(/\{\{result:each\}\}/.test(consumer.prompt || ""), "reads the forEach leaf's results: " + consumer.prompt);
});

test("buildManifest: an explicit allowedTools survives the write-tools default ★", () => {
  // An implementation leaf is told to COMMIT its work, so it needs Bash. The
  // driver may only FILL a missing allowedTools, never overwrite a stated one —
  // silently stripping Bash leaves the leaf unable to do the job it was given.
  const plan = buildManifest({
    items: [
      { id: "p1", prompt: "implement and commit", model: "haiku", allowedTools: "Read,Grep,Glob,Write,Edit,Bash" },
      { id: "p2", prompt: "build on it and commit", model: "haiku", buildsOnCommitsOf: "p1",
        allowedTools: "Read,Grep,Glob,Write,Edit,Bash" },
    ],
    combinedOutput: { into: "feat", mode: "commits" },
  });
  for (const id of ["p1", "p2"]) {
    const t = plan.tasks.find((x) => x.id === id);
    ok(/Bash/.test(t.allowedTools), `${id} keeps its stated tools, got: ${t.allowedTools}`);
  }
});

test("buildManifest: a leaf that must write gets write tools when none were stated", () => {
  const plan = buildManifest({
    items: [{ id: "a", prompt: "edit", model: "haiku" }, { id: "b", prompt: "edit on top", model: "haiku", buildsOnCommitsOf: "a" }],
  });
  ok(/Write/.test(plan.tasks.find((t) => t.id === "a").allowedTools), "the default still fills a gap");
});

test("buildManifest: per-item engine fields pass through — one blob keeps the engine's full surface", () => {
  const plan = buildManifest({
    items: [
      { id: "a", prompt: "p", model: "haiku", allowedTools: "Read,Grep,Glob,Write,Edit", effort: "high",
        cwd: "C:/code/x", timeoutMs: 1234, returns: { type: "object" }, fallbackModel: "glm-5.2:cloud",
        outputDir: "out", when: { from: "z", expr: "true" } },
    ],
  });
  const a = plan.tasks[0];
  equal(a.allowedTools, "Read,Grep,Glob,Write,Edit");
  equal(a.effort, "high");
  equal(a.cwd, "C:/code/x");
  equal(a.timeoutMs, 1234);
  deepEqual(a.returns, { type: "object" });
  equal(a.fallbackModel, "glm-5.2:cloud");
  equal(a.outputDir, "out");
  deepEqual(a.when, { from: "z", expr: "true" });
  ok(!("buildsOnCommitsOf" in a), "shape-only keys never reach the engine");
});

test("buildManifest: an item that consumes another's OUTPUT gets the after edge (a chain link)", () => {
  const plan = buildManifest({
    items: [
      { id: "scan", prompt: "scan", model: "haiku" },
      { id: "fix", prompt: "fix what {{result:scan}} found", model: "haiku", after: ["scan"] },
    ],
  });
  deepEqual(plan.tasks.find((t) => t.id === "fix").after, ["scan"]);
  ok(!plan.tasks.find((t) => t.id === "fix").isolation, "output, not commits: no isolation.from");
});

// ── The step machine — the driver owns sequencing and the task list ──────────
// writing-skills+ driver contract: a fixed step list, each step guarded on the
// WORLD (never the marker), seeded as [TASK_CREATE] lines on the first run and
// advanced with [TASK_UPDATE] as reality changes. The model mirrors; it never
// authors a parallel list.

const DRIVER_PATH = fileURLToPath(new URL("./run-swarm.mjs", import.meta.url));
function runDriver(home, args) {
  const r = spawnSync(process.execPath, [DRIVER_PATH, ...args], {
    encoding: "utf8",
    env: { ...process.env, SWARM_HOME: home },
  });
  return { code: r.status, out: (r.stdout || "") + (r.stderr || "") };
}
const SHAPE_COMBINED = {
  items: [
    { id: "ref-a", prompt: "document a", model: "haiku" },
    { id: "ref-b", prompt: "document b", model: "haiku" },
  ],
  combinedOutput: { into: "REFERENCE.md", label: "consistent terms" },
};

test("DRIVER_STEPS: the full sequence, read first, liveness last", () => {
  equal(DRIVER_STEPS[0], "read-strategy");
  equal(DRIVER_STEPS[DRIVER_STEPS.length - 1], "liveness");
  for (const s of ["shape", "author", "validate", "gate", "dispatch"]) ok(DRIVER_STEPS.includes(s), s);
  ok(DRIVER_STEPS.indexOf("author") < DRIVER_STEPS.indexOf("validate"), "author before validate");
  ok(DRIVER_STEPS.indexOf("validate") < DRIVER_STEPS.indexOf("gate"), "validate before gate");
});

test("stepDone(author): guards on the manifest FILE holding the emitted graph, not the marker ★", () => {
  const shape = SHAPE_COMBINED;
  ok(!stepDone("author", { meta: { author: "done" }, shape, manifestOnDisk: null }),
     "a marker with no file is not done");
  const built = buildManifest(shape);
  ok(stepDone("author", { meta: {}, shape, manifestOnDisk: built }), "the file with the emitted graph is done");
  const missingNode = { tasks: built.tasks.filter((t) => !t.after) };
  ok(!stepDone("author", { meta: {}, shape, manifestOnDisk: missingNode }),
     "a file missing the consuming node is NOT done — the driver rewrites it");
});

test("stepDone(author): a digest-only shape edit still rewrites the manifest ★", () => {
  // digest is model-editable per the shape banner. Comparing only `tasks` reports
  // author-done and the stale digest block ships to dispatch forever.
  const items = [{ id: "a", prompt: "p", model: "haiku" }];
  const onDisk = { ...buildManifest({ items }), digest: { model: "haiku", instructions: "OLD" } };
  const edited = { items, digest: { model: "haiku", instructions: "NEW" } };
  ok(!stepDone("author", { meta: {}, shape: edited, manifestOnDisk: onDisk }),
     "a changed digest must not count as authored");
});

test("stepDone(validate): needs a passing validation OF the file that is on disk", () => {
  const w = { meta: { validate: { ok: true, file: "/m.json" } }, manifestFile: "/m.json", manifestOnDisk: { tasks: [] } };
  ok(stepDone("validate", w));
  ok(!stepDone("validate", { ...w, manifestOnDisk: null }), "file gone -> not done");
  ok(!stepDone("validate", { ...w, meta: { validate: { ok: false, file: "/m.json" } } }));
  ok(!stepDone("validate", { ...w, meta: { validate: { ok: true, file: "/other.json" } } }),
     "a different file's validation does not count");
});

test("stepDone: an unrecognised step is never assumed done", () => {
  ok(!stepDone("nonsense", { meta: { nonsense: true } }));
});

test("firstIncompleteStep: resumes at the first step the world says is outstanding", () => {
  const shape = SHAPE_COMBINED;
  equal(firstIncompleteStep({ meta: {} }), "read-strategy");
  equal(firstIncompleteStep({ meta: { "read-strategy": "done" } }), "shape");
  equal(firstIncompleteStep({ meta: { "read-strategy": "done" }, shape, manifestOnDisk: null }), "author");
  const built = buildManifest(shape);
  equal(firstIncompleteStep({ meta: { "read-strategy": "done" }, shape, manifestOnDisk: built, manifestFile: "/m" }), "validate");
  equal(firstIncompleteStep({
    meta: { "read-strategy": "done", validate: { ok: true, file: "/m" } }, shape, manifestOnDisk: built, manifestFile: "/m",
  }), "gate");
});

test("stepTaskLines: seeds every step on first run, then emits only the changed statuses", () => {
  const seed = stepTaskLines({ previous: null, current: { "read-strategy": "completed", shape: "in_progress" } });
  equal(seed.filter((l) => l.startsWith("[TASK_CREATE] swarm: ")).length, DRIVER_STEPS.length);
  ok(seed.includes("[TASK_UPDATE] 0 completed"), seed.join("\n"));
  ok(seed.includes("[TASK_UPDATE] 1 in_progress"));
  const later = stepTaskLines({
    previous: { "read-strategy": "completed", shape: "in_progress" },
    current: { "read-strategy": "completed", shape: "completed", author: "completed", validate: "in_progress" },
  });
  ok(!later.some((l) => l.startsWith("[TASK_CREATE]")), "no re-seeding");
  deepEqual(later, ["[TASK_UPDATE] 1 completed", "[TASK_UPDATE] 2 completed", "[TASK_UPDATE] 3 in_progress"]);
});

test("driver: first named run seeds one [TASK_CREATE] per step and asks for the shape, not a manifest ★", () => {
  const home = mkdtempSync(pj(tmpdir(), "swarm-drv-"));
  const r = runDriver(home, ["--manifest", "t1", "--read-strategy", "done"]);
  equal(r.code, 0, r.out);
  for (const s of DRIVER_STEPS) ok(r.out.includes(`[TASK_CREATE] swarm: ${s}`), `seeds ${s}: ${r.out}`);
  ok(/shape-file/.test(r.out), "asks for the shape answers: " + r.out);
  ok(!/author the manifest/i.test(r.out), "never asks the model to author the manifest JSON");
  ok(/combinedOutput/.test(r.out), "the shape question names the combined-output field");
});

test("driver: given the shape, it WRITES the manifest with the consuming node and runs validate itself ★", () => {
  const home = mkdtempSync(pj(tmpdir(), "swarm-drv-"));
  const shapeFile = pj(home, "shape.json");
  wfs(shapeFile, JSON.stringify(SHAPE_COMBINED));
  runDriver(home, ["--manifest", "t2", "--read-strategy", "done"]);
  const r = runDriver(home, ["--manifest", "t2", "--shape-file", shapeFile]);
  equal(r.code, 0, r.out);
  const state = JSON.parse(rfs(pj(home, "driver", "t2.json"), "utf8"));
  ok(state.meta.manifestFile && exs(state.meta.manifestFile), "driver wrote the manifest file: " + r.out);
  const m = JSON.parse(rfs(state.meta.manifestFile, "utf8"));
  ok(m.tasks.some((t) => Array.isArray(t.after) && t.after.includes("ref-a") && t.after.includes("ref-b")),
     "the consuming node is in the FILE the engine will run");
  ok(state.meta.validate && state.meta.validate.ok === true, "validate ran and passed: " + r.out);
  ok(/TASK_UPDATE\] 1 completed/.test(r.out) && /TASK_UPDATE\] 2 completed/.test(r.out), "shape+author flipped: " + r.out);
  ok(/offer gate/i.test(r.out), "advanced straight to the gate: " + r.out);
});

test("driver: re-running mid-loop does not re-do a completed step (idempotent)", () => {
  const home = mkdtempSync(pj(tmpdir(), "swarm-drv-"));
  const shapeFile = pj(home, "shape.json");
  wfs(shapeFile, JSON.stringify(SHAPE_COMBINED));
  runDriver(home, ["--manifest", "t3", "--read-strategy", "done"]);
  runDriver(home, ["--manifest", "t3", "--shape-file", shapeFile]);
  const again = runDriver(home, ["--manifest", "t3"]);
  equal(again.code, 0, again.out);
  ok(!/TASK_CREATE/.test(again.out), "no re-seed");
  ok(!/shape-file/.test(again.out), "does not re-ask for the shape");
  ok(/offer gate/i.test(again.out), "still at the gate: " + again.out);
});

test("driver: gate answers are IGNORED until validate has passed — the chain stays backward ★", () => {
  const home = mkdtempSync(pj(tmpdir(), "swarm-drv-"));
  const shapeFile = pj(home, "shape.json");
  // An unlaunchable model makes validate fail, so the world never reaches the gate.
  wfs(shapeFile, JSON.stringify({ items: [{ id: "a", prompt: "p", model: "no-such-model-xyz" }] }));
  runDriver(home, ["--manifest", "t5", "--read-strategy", "done"]);
  const r = runDriver(home, ["--manifest", "t5", "--shape-file", shapeFile,
    "--gate-fanout", "yes", "--gate-mix", "as drafted", "--gate-batching", "1"]);
  equal(r.code, 0, r.out);
  const state = JSON.parse(rfs(pj(home, "driver", "t5.json"), "utf8"));
  ok(!("fanout" in state.meta), "a gate answer banked before validation is not consent: " + JSON.stringify(state.meta));
  ok(!/TASK_UPDATE\] 4 completed/.test(r.out), "the gate step must not flip to completed");
});

test("driver --dry-run: walks the same path, reports the writes, performs none ★", () => {
  const home = mkdtempSync(pj(tmpdir(), "swarm-drv-"));
  const shapeFile = pj(home, "shape.json");
  wfs(shapeFile, JSON.stringify(SHAPE_COMBINED));
  const r = runDriver(home, ["--manifest", "t4", "--read-strategy", "done", "--shape-file", shapeFile, "--dry-run"]);
  equal(r.code, 0, r.out);
  ok(/dry-run: would write/i.test(r.out), "reports the manifest write: " + r.out);
  ok(!exs(pj(home, "driver", "t4.json")), "no state file written");
  ok(!exs(pj(home, "driver", "t4.manifest.json")), "no manifest written");
  ok(/TASK_CREATE/.test(r.out), "the task projection still prints — it is output, not state");
});
