// Scores one cell's outcome against a baseline's: the operator-visible measures on
// which this build is worse. The same rules serve the CI test and the gate script.

const WHEN_RANK = { "in-turn": 2, "after the turn": 1, never: 0 };

// Each measure: a name, and whether `b` is worse than `base` on it.
const MEASURES = [
  ["the message reaches the session once", (b, base) => base.seen === 1 && b.seen !== 1],
  ["the message reaches the session as early", (b, base) => b.when !== null && WHEN_RANK[b.when] < WHEN_RANK[base.when]],
  ["one block is up while the session works on it", (b, base) => base.block === 1 && b.block !== 1],
  ["nothing ticks once the turn is over", (b, base) => base.ticking === 0 && b.ticking > 0],
  ["Slack still reaches the idle session", (b, base) => base.reachable && !b.reachable],
];

export function regressions(outcome, base) {
  if (outcome.failed || outcome.error) return [`the cell did not run: ${outcome.failed ?? outcome.error}`];
  return MEASURES.filter(([, worse]) => worse(outcome, base)).map(([name]) => name);
}
