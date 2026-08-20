import { test } from "node:test";
import { equal, ok } from "node:assert/strict";
import { gateDispatch } from "../hooks/dispatch-gate.mjs";
import { shouldAck } from "../hooks/skill-ack.mjs";

// A session that never invokes the swarm skill is bound by nothing in it. The
// observed vector is a raw `swarm.mjs run …` copied into a STATE handover and
// executed by a session that never opens the skill — so the gate must fire on the
// command itself, the one thing every path through the bypass has in common.
// Each case below pins a violation observed on 2026-07-12 (long-night P5 review).

const ENGINE = "swarm" + ".mjs";
const RUN = 'node "C:/p/swarm/scripts/swarm.mjs" run p5-review';

test("gate ignores the free subcommands — they spend nothing", () => {
  for (const command of [
    'node swarm.mjs status C:/runs/p5-review-1 --watch',
    "node swarm.mjs validate p5-review",
    "node swarm.mjs models",
    "node swarm.mjs list",
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
    const r = gateDispatch({ command, runInBackground: true, markerExists: true });
    equal(r.block, true, `must block: ${command}`);
    ok(re.test(r.reason), `reason must name the offence for "${command}": ${r.reason}`);
  }
});

// A foreground dispatch buries the live frames in a tool result — same harm as a pipe.
test("gate BLOCKS a foreground dispatch even with a marker", () => {
  const r = gateDispatch({ command: RUN, runInBackground: false, markerExists: true });
  equal(r.block, true);
  ok(/run_in_background/.test(r.reason), r.reason);
});

// The happy path must actually pass, or the gate is just a wall.
test("gate PASSES a bare backgrounded dispatch with a marker, and consumes the marker", () => {
  const r = gateDispatch({ command: RUN, runInBackground: true, markerExists: true });
  equal(r.block, false);
  equal(r.consumeMarker, true, "one skill invocation authorises one dispatch");
});

// A dispatch that never got past the gate must not eat the marker — otherwise a
// blocked pipe would silently disarm the next (correct) attempt.
test("a blocked dispatch never consumes the marker", () => {
  for (const args of [
    { command: `${RUN} | tail -5`, runInBackground: true, markerExists: true },
    { command: RUN, runInBackground: false, markerExists: true },
    { command: RUN, runInBackground: true, markerExists: false },
  ]) {
    const r = gateDispatch(args);
    equal(r.block, true);
    ok(!r.consumeMarker, `blocked dispatch must not consume the marker: ${args.command}`);
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

// ── The gate must fire on EXECUTION, not on a mention ────────────────────────
// The gate must key on executable position, not string presence: a grep for the
// command, a heredoc documenting it, a comment, and the gate's own tests all
// mention it without spending anything. Over-blocking is not the safe direction —
// it makes the gate untestable through Bash and teaches routing around it.

test("gate ignores a command that only MENTIONS the dispatch", () => {
  for (const command of [
    `grep -rn "${ENGINE} run" .`,
    `rg "${ENGINE} run" --glob '*.md'`,
    `echo "node ${ENGINE} run x" >> plan.md`,
    `cat notes.md | grep "${ENGINE} run"`,
    `# node ${ENGINE} run x`,
    `git commit -m "document the ${ENGINE} run flow"`,
  ]) {
    equal(
      gateDispatch({ command, runInBackground: true, markerExists: false }).block,
      false,
      `should not block: ${command}`,
    );
  }
});

test("gate still fires on a real dispatch in a compound command", () => {
  // The narrowing must not open a hole: a dispatch after a separator still runs.
  for (const command of [
    `cd /tmp && node ${ENGINE} run plan.json`,
    `cd /tmp; node ${ENGINE} run plan.json`,
  ]) {
    equal(
      gateDispatch({ command, runInBackground: true, markerExists: false }).block,
      true,
      `should block: ${command}`,
    );
  }
});

// The narrowing above must not open a hole. Every form below actually executes the
// engine and must stay blocked — this is the adversarial half of the same change.
test("narrowing to executable position opens no bypass", () => {
  for (const command of [
    `node ${ENGINE} run p`,
    `node "C:/p/scripts/${ENGINE}" run p`,
    `node 'C:\\p\\scripts\\${ENGINE}' run p`,
    `cd /tmp && node ${ENGINE} run p`,
    `cd /tmp; node ${ENGINE} run p`,
    `nohup node ${ENGINE} run p &`,
    `exec node ${ENGINE} run p`,
    `time node ${ENGINE} run p`,
    `env FOO=1 node ${ENGINE} run p`,
    `  node ${ENGINE} run p`,
    `node ${ENGINE} run p --force`,
    `(node ${ENGINE} run p)`,
    `/usr/bin/node ${ENGINE} run p`,
    `node.exe ${ENGINE} run p`,
    `node ${ENGINE} run p | tail`,
  ]) {
    equal(
      gateDispatch({ command, runInBackground: true, markerExists: false }).block,
      true,
      `must still block: ${command}`,
    );
  }
});

// Four bypasses the first adversarial probe missed: it enumerated the shapes its
// author thought of, and a newline was not among them. A gate that must catch
// every real dispatch cannot miss the commonest multi-line shell shape there is.
test("executable position includes newline, backtick and keyword introducers", () => {
  for (const command of [
    `echo hi\nnode ${ENGINE} run p`,
    "echo `node " + ENGINE + " run p`",
    `if true; then node ${ENGINE} run p; fi`,
    `for i in 1; do node ${ENGINE} run p; done`,
    `while :; do node ${ENGINE} run p; done`,
    `if x; then y; else node ${ENGINE} run p; fi`,
    `{ node ${ENGINE} run p; }`,
    `echo a\n\tnode ${ENGINE} run p`,
  ]) {
    equal(
      gateDispatch({ command, runInBackground: true, markerExists: false }).block,
      true,
      `must block: ${JSON.stringify(command)}`,
    );
  }
});

// The narrowing must not creep back into over-blocking: a mention on its own
// line is still a mention.
test("a mention on its own line is still not a dispatch", () => {
  for (const command of [
    `echo hi\ngrep "${ENGINE} run" .`,
    `cat <<EOF\nnode ${ENGINE} run p\nEOF`,
  ]) {
    equal(
      gateDispatch({ command, runInBackground: true, markerExists: false }).block,
      false,
      `must not block: ${JSON.stringify(command)}`,
    );
  }
});
