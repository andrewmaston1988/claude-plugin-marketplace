// Graph shapes for the rail router, as the page hands them over: display order, one
// entry per drawn row. `railInput` rows go straight to railLayout; `pageRows` rows are
// buildRows-shaped and go through railRows first (remaps + reduction).
const node = (key, parents = [], states = ["ok"], extra = {}) => ({ key, parents, states, kind: "node", ...extra });
const label = (key, parents, states = ["running"]) => ({ key, parents, states, kind: "label" });
const indexed = (rows) => rows.map((r, index) => ({ index, ...r }));
const range = (n) => Array.from({ length: n }, (_, i) => i);

// One clone's sessions under forEach X: steps is [[local, localParents], …].
function cloneRows(X, c, steps, states = {}) {
  const locals = new Set(steps.map(([l]) => l));
  const depended = new Set(steps.flatMap(([, ps]) => ps));
  return steps.map(([local, ps]) => {
    const key = `${X}[${c}]~${local}`;
    const root = !ps.some((p) => locals.has(p));
    return node(key, root ? [X] : ps.map((p) => `${X}[${c}]~${p}`), [states[key] || "pending"],
      { block: X, root, sink: !depended.has(local) });
  });
}
const CHAIN = [["walk", []], ["extend", ["walk"]], ["verify", ["extend"]]];

export const FAN_OUT = indexed([node("scout"), ...range(6).map((i) => node(`lens-${i}`, ["scout"]))]);
export const FAN_IN = indexed([...range(6).map((i) => node(`find-${i}`)), node("verdict", range(6).map((i) => `find-${i}`))]);
export const DIAMOND = indexed([node("plan"), ...range(4).map((i) => node(`w${i}`, ["plan"])), node("join", range(4).map((i) => `w${i}`))]);
export const CROSSED = indexed([
  node("plan"), node("a", ["plan"]), node("b", ["plan"]), node("c", ["plan"]),
  node("x", ["a", "b"]), node("y", ["b", "c"]), node("z", ["a", "c"]), node("final", ["x", "y", "z"]),
]);
export const WIDE_20 = indexed([...range(20).map((i) => node(`s${i}`)), node("verdict", range(20).map((i) => `s${i}`))]);
export const SIDE_BRANCH = indexed([node("spec"), node("impl", ["spec"]), node("docs", ["spec"]), node("review", ["impl"]), node("land", ["review", "docs"])]);

// Three forEach blocks in one wave, glossary downstream. ln[0]'s verify is running and
// merges first; ln[1] has not started.
export const GLOSSARY_STATES = {
  "chain-ln[0]~walk": "ok", "chain-ln[0]~extend": "ok", "chain-ln[0]~verify": "running",
  "chain-pr[0]~walk": "rate-limited",
};
export const GLOSSARY = indexed([
  node("enum-ln"), node("enum-pr"), node("enum-gp"),
  label("chain-ln", ["enum-ln"]),
  ...range(3).flatMap((c) => cloneRows("chain-ln", c, CHAIN, GLOSSARY_STATES)),
  label("chain-pr", ["enum-pr"]),
  ...range(2).flatMap((c) => cloneRows("chain-pr", c, CHAIN, GLOSSARY_STATES)),
  label("chain-gp", ["enum-gp"]),
  ...range(2).flatMap((c) => cloneRows("chain-gp", c, CHAIN, GLOSSARY_STATES)),
  node("glossary", ["chain-ln", "chain-pr", "chain-gp"], ["pending"]),
]);

// A clone whose child fans out and back in.
export const INTERNAL_FANOUT = indexed([
  node("up"), label("X", ["up"]),
  ...cloneRows("X", 0, [["walk", []], ["a", ["walk"]], ["b", ["walk"]], ["verify", ["a", "b"]]]),
  node("down", ["X"], ["pending"]),
]);

// A plain forEach: every clone is its own root and sink.
export const PLAIN_FOREACH = indexed([
  node("up"), label("fix", ["up"]),
  ...range(4).map((c) => node(`fix[${c}]`, ["fix"], ["ok"], { block: "fix", root: true, sink: true })),
  node("join", ["fix"], ["pending"]),
]);

// A clone still waiting on concurrency sits between two expanded ones.
export const UNEXPANDED = indexed([
  node("up"), label("X", ["up"]),
  ...cloneRows("X", 0, [["walk", []], ["verify", ["walk"]]]),
  node("X[1]", ["X"], ["pending"], { block: "X", root: true, sink: true }),
  ...cloneRows("X", 2, [["walk", []], ["verify", ["walk"]]]),
  node("down", ["X"], ["pending"]),
]);

// ── buildRows-shaped rows, for railRows ──────────────────────────────────
const task = (id, after = [], state = "ok") => ({ id, after, state });

// A 30-clone forEach whose digest's `after` is every row, exactly as topology sets it.
export function thirtyCloneDigest() {
  const up = task("up");
  const X = task("X", ["up"], "running");
  const members = range(30).flatMap((c) => [task(`X[${c}]~walk`, ["up"]), task(`X[${c}]~verify`, [`X[${c}]~walk`])]);
  const digest = task("__digest", ["up", "X", ...members.map((m) => m.id)], "pending");
  return [
    { type: "wave", wave: 0, open: true, tasks: [up] },
    { type: "task", wave: 0, id: "up", task: up },
    { type: "wave", wave: 1, open: true, tasks: [X, ...members] },
    { type: "label", wave: 1, id: "X", task: X, kids: members },
    ...members.map((m) => ({ type: "task", wave: 1, id: m.id, task: m, block: "X" })),
    { type: "wave", wave: 2, open: true, tasks: [digest] },
    { type: "task", wave: 2, id: "__digest", task: digest },
  ];
}

// Wave 1 is collapsed into one row; d waits on a member of it.
export function collapsedWave() {
  const a = task("a"), b = task("b", ["a"]), c = task("c", ["a"]), d = task("d", ["b"], "pending");
  return [
    { type: "wave", wave: 0, open: true, tasks: [a] },
    { type: "task", wave: 0, id: "a", task: a },
    { type: "wave", wave: 1, open: false, tasks: [b, c] },
    { type: "wave", wave: 2, open: true, tasks: [d] },
    { type: "task", wave: 2, id: "d", task: d },
  ];
}

export const SHAPES = { FAN_OUT, FAN_IN, DIAMOND, CROSSED, WIDE_20, SIDE_BRANCH, GLOSSARY, INTERNAL_FANOUT, PLAIN_FOREACH, UNEXPANDED };
