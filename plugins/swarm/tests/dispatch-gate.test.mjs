import { test } from "node:test";
import { equal, ok } from "node:assert/strict";
import { gateDispatch, markerPath, groupingMarkerPath, shapeMarkerPath } from "../hooks/dispatch-gate.mjs";
import { shouldAck, ackTargets } from "../hooks/skill-ack.mjs";

// A session that never invokes the swarm skill is bound by nothing in it. The
// observed vector is a raw `swarm.mjs run …` copied into a STATE handover and
// executed by a session that never opens the skill — so the gate must fire on the
// command itself, the one thing every path through the bypass has in common.
// Each case below pins a violation observed on 2026-07-12 (long-night P5 review).

const RUN = 'node "C:/p/swarm/scripts/swarm.mjs" run p5-review';

test("gate ignores the free subcommands — they spend nothing", () => {
  for (const command of [
    'node swarm.mjs status C:/runs/p5-review-1 --watch',
    "node swarm.mjs validate p5-review",
    "node swarm.mjs models",
    "node swarm.mjs list",
    "node swarm.mjs serve --daemon",
    'node swarm.mjs ask C:/runs/x find-a "what did you mean"',
  ]) {
    equal(gateDispatch({ command, runInBackground: false, markerExists: false }).block, false, command);
  }
});

test("gate ignores commands that have nothing to do with the engine", () => {
  equal(gateDispatch({ command: "git status", runInBackground: false, markerExists: false }).block, false);
  equal(gateDispatch({ command: "npm run swarm", runInBackground: false, markerExists: false }).block, false);
});

// Failure 1: dispatched a 9-leaf, 6.56M-token run with no offer gate, because the
// skill — which carries the gate — was never loaded.
test("gate BLOCKS a run with no skill marker, and names the skill", () => {
  const r = gateDispatch({ command: RUN, runInBackground: true, markerExists: false });
  equal(r.block, true);
  ok(/swarm:swarm/.test(r.reason), r.reason);
  ok(/skill/i.test(r.reason), r.reason);
});

// Failure 2a/2b/2c: the dispatch was piped, redirected, and nohup'd on three
// consecutive rounds — each time destroying the operator's only live view.
test("gate BLOCKS a decorated dispatch and names the offence", () => {
  const cases = [
    [`${RUN} | tail -40`, /pipe/i],
    [`${RUN} > log 2>&1`, /redirect/i],
    [`${RUN} >> run.log`, /redirect/i],
    [`nohup ${RUN} &`, /nohup|background/i],
    [`${RUN} &`, /background|&/],
    [`${RUN} | grep ok`, /pipe/i],
  ];
  for (const [command, re] of cases) {
    const r = gateDispatch({ command, runInBackground: true, markerExists: true, groupingMarkerExists: true, shapeMarkerExists: true });
    equal(r.block, true, `must block: ${command}`);
    ok(re.test(r.reason), `reason must name the offence for "${command}": ${r.reason}`);
  }
});

// A foreground dispatch buries the live frames in a tool result — same harm as a pipe.
test("gate BLOCKS a foreground dispatch even with a marker", () => {
  const r = gateDispatch({ command: RUN, runInBackground: false, markerExists: true, groupingMarkerExists: true, shapeMarkerExists: true });
  equal(r.block, true);
  ok(/run_in_background/.test(r.reason), r.reason);
});

// The happy path must actually pass, or the gate is just a wall.
test("gate PASSES a bare backgrounded dispatch with all three markers, and consumes only the swarm marker", () => {
  const r = gateDispatch({ command: RUN, runInBackground: true, markerExists: true, groupingMarkerExists: true, shapeMarkerExists: true });
  equal(r.block, false);
  equal(r.consumeMarker, true, "one skill invocation authorises one dispatch");
});

// A dispatch that never got past the gate must not eat the marker — otherwise a
// blocked pipe would silently disarm the next (correct) attempt.
test("a blocked dispatch never consumes the marker", () => {
  for (const args of [
    { command: `${RUN} | tail -5`, runInBackground: true, markerExists: true, groupingMarkerExists: true, shapeMarkerExists: true },
    { command: RUN, runInBackground: false, markerExists: true, groupingMarkerExists: true, shapeMarkerExists: true },
    { command: RUN, runInBackground: true, markerExists: false, groupingMarkerExists: true, shapeMarkerExists: true },
  ]) {
    const r = gateDispatch(args);
    equal(r.block, true);
    ok(!r.consumeMarker, `blocked dispatch must not consume the marker: ${args.command}`);
  }
});

// The grouping skills are reading, not consent — the swarm marker guards spend,
// these guard whether the manifest was shaped by the plan's files or its narrative.
test("gate BLOCKS with the swarm marker present but the grouping marker missing, naming orchestrating-agents", () => {
  const r = gateDispatch({ command: RUN, runInBackground: true, markerExists: true, groupingMarkerExists: false, shapeMarkerExists: true });
  equal(r.block, true);
  ok(/swarm:orchestrating-agents/.test(r.reason), r.reason);
  ok(!/swarm:executing-swarms/.test(r.reason), r.reason);
});

test("gate BLOCKS with the swarm marker present but the shape marker missing, naming executing-swarms", () => {
  const r = gateDispatch({ command: RUN, runInBackground: true, markerExists: true, groupingMarkerExists: true, shapeMarkerExists: false });
  equal(r.block, true);
  ok(/swarm:executing-swarms/.test(r.reason), r.reason);
  ok(!/swarm:orchestrating-agents/.test(r.reason), r.reason);
});

test("gate BLOCKS naming both grouping skills when both markers are missing", () => {
  const r = gateDispatch({ command: RUN, runInBackground: true, markerExists: true, groupingMarkerExists: false, shapeMarkerExists: false });
  equal(r.block, true);
  ok(/swarm:orchestrating-agents/.test(r.reason), r.reason);
  ok(/swarm:executing-swarms/.test(r.reason), r.reason);
});

// The phrase can appear anywhere in a Bash command that just happens to quote it —
// a PR body, a commit message — without that being a dispatch. The gate must key on
// the engine path being the command word, not on the phrase appearing anywhere.
test("gate does NOT fire on the phrase embedded in an unrelated quoted argument", () => {
  const bodyCmd = 'gh pr create --body "Tested: node swarm.mjs run manifest.json passed locally"';
  const commitCmd = 'git commit -m "Fix: previously node swarm.mjs run bypassed the gate"';
  equal(gateDispatch({ command: bodyCmd, runInBackground: true, markerExists: false }).block, false, bodyCmd);
  equal(gateDispatch({ command: commitCmd, runInBackground: true, markerExists: false }).block, false, commitCmd);
});

// A real dispatch is still caught wherever it sits as the command word — at the
// start, or after a separator.
test("gate still fires when the engine path is the command word, at start or after a separator", () => {
  const cases = [
    "node C:/x/swarm.mjs run m.json",
    "cd repo && node ./swarm.mjs run m.json",
    "echo x; node swarm.mjs run m.json",
  ];
  for (const command of cases) {
    equal(gateDispatch({ command, runInBackground: true, markerExists: false }).block, true, command);
  }
});

// The path may be quoted, use either slash, or carry flags — the gate keys on the
// engine + subcommand, not on a literal string.
test("gate recognises the dispatch across quoting, slashes, and flags", () => {
  for (const command of [
    "node C:/p/swarm/scripts/swarm.mjs run p5-review --force",
    "node 'C:\\p\\swarm\\scripts\\swarm.mjs' run p5-review",
    'node "/c/p/swarm/scripts/swarm.mjs" run manifest.json --args \'{"base":"master"}\'',
  ]) {
    equal(gateDispatch({ command, runInBackground: true, markerExists: false }).block, true, command);
  }
});

// Fail open: a malformed payload must never wedge the session.
test("gate fails open on a missing or empty command", () => {
  equal(gateDispatch({ command: undefined, runInBackground: true, markerExists: false }).block, false);
  equal(gateDispatch({ command: "", runInBackground: true, markerExists: false }).block, false);
});

// The marker writer — the other half of the contract. The payload shape is the one
// the working commit-skill marker uses: tool_name "Skill", skill at tool_input.skill.
// A plugin skill may arrive namespaced or bare, so accept both.
test("marker is written for the swarm skill, namespaced or bare", () => {
  equal(shouldAck({ tool_name: "Skill", tool_input: { skill: "swarm:swarm" } }), true);
  equal(shouldAck({ tool_name: "Skill", tool_input: { skill: "swarm" } }), true);
});

test("marker is NOT written for another skill or another tool", () => {
  equal(shouldAck({ tool_name: "Skill", tool_input: { skill: "commit" } }), false);
  equal(shouldAck({ tool_name: "Bash", tool_input: { command: "node swarm.mjs run x" } }), false);
  equal(shouldAck({}), false);
  equal(shouldAck({ tool_name: "Skill", tool_input: {} }), false);
});

// ackTargets is the marker-writing half of the three-marker contract: the swarm
// skill still arms the dispatch marker, and the two grouping skills each arm
// their own — namespaced or bare, same acceptance as the swarm skill.
test("ackTargets maps the six spellings to the right marker paths", () => {
  const sid = "sess-1";
  const base = { session_id: sid, tool_name: "Skill" };
  equal(ackTargets({ ...base, tool_input: { skill: "swarm:swarm" } })[0], markerPath(sid));
  equal(ackTargets({ ...base, tool_input: { skill: "swarm" } })[0], markerPath(sid));
  equal(ackTargets({ ...base, tool_input: { skill: "swarm:orchestrating-agents" } })[0], groupingMarkerPath(sid));
  equal(ackTargets({ ...base, tool_input: { skill: "orchestrating-agents" } })[0], groupingMarkerPath(sid));
  equal(ackTargets({ ...base, tool_input: { skill: "swarm:executing-swarms" } })[0], shapeMarkerPath(sid));
  equal(ackTargets({ ...base, tool_input: { skill: "executing-swarms" } })[0], shapeMarkerPath(sid));
});

test("ackTargets returns nothing for another skill, another tool, or a missing session", () => {
  const sid = "sess-1";
  equal(ackTargets({ session_id: sid, tool_name: "Skill", tool_input: { skill: "commit" } }).length, 0);
  equal(ackTargets({ session_id: sid, tool_name: "Bash", tool_input: { command: "node swarm.mjs run x" } }).length, 0);
  equal(ackTargets({}).length, 0);
  equal(ackTargets({ session_id: sid, tool_name: "Skill", tool_input: {} }).length, 0);
  equal(ackTargets({ tool_name: "Skill", tool_input: { skill: "swarm" } }).length, 0);
});
