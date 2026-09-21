// Section A of swarm-guidance-from-commands: the roster's per-leaf token cell is
// the WORK figure (input + output + cache writes), not the cacheRead-inclusive
// total. Every row below asserts on a RENDERED roster line — a row that called
// workTokens directly would pass without the cell in results.mjs ever changing.
import { test } from "node:test";
import { equal, ok, match } from "node:assert/strict";
import { renderRoster } from "../src/results.mjs";
import { buildSnapshot } from "../src/serve/estate.mjs";

const NOW = Date.parse("2026-07-11T12:04:12Z");
const tok = (o) => ({ input: 0, output: 0, cacheCreation: 0, cacheRead: 0, ...o });

// The last field of a rendered leaf row is its token cell. Anchoring on the id
// keeps this independent of row order and of the column widths.
function cellFor(block, id) {
  const line = block.split("\n").find((l) => l.trim().split(/\s+/)[1] === id);
  ok(line, `no roster row for ${id} in:\n${block}`);
  return line.trimEnd().split(/\s+/).pop();
}

const cellNum = (s) =>
  s.endsWith("M") ? Number(s.slice(0, -1)) * 1e6
    : s.endsWith("k") ? Number(s.slice(0, -1)) * 1e3 : Number(s);

const footerOf = (block) => block.split("\n").filter((l) => l.trim()).pop();

// A Claude leaf's re-served prefix lands in cacheRead. This is the shape that
// rendered a headline ~100x a :cloud leaf doing identical work.
const CLAUDE_SHAPED = tok({ input: 1000, output: 500, cacheRead: 9_000_000 });
const CLOUD_SHAPED = tok({ input: 1400, output: 600 });

test("roster cell: a Claude-shaped leaf renders its work, not its re-served prefix", () => {
  const tasks = [{ id: "claude-impl", model: "opus", state: "ok", durationMs: 312000, tokens: CLAUDE_SHAPED }];
  const block = renderRoster({ title: "t", tasks, now: NOW, startedMs: NOW - 312000 });
  // 9M is the cacheRead. The work is 1000 + 500 = 1.5k, and nothing else.
  equal(cellFor(block, "claude-impl"), "1.5k");
});

test("roster cell: a Claude leaf and a :cloud leaf doing equal work render comparable cells", () => {
  const tasks = [
    { id: "claude-impl", model: "opus", state: "ok", durationMs: 312000, tokens: CLAUDE_SHAPED },
    { id: "cloud-impl", model: "glm-5.2:cloud", state: "ok", durationMs: 312000, tokens: CLOUD_SHAPED },
  ];
  const block = renderRoster({ title: "t", tasks, now: NOW, startedMs: NOW - 312000 });
  const a = cellNum(cellFor(block, "claude-impl"));
  const b = cellNum(cellFor(block, "cloud-impl"));
  const ratio = Math.max(a, b) / Math.min(a, b);
  ok(ratio < 10, `cells must be within an order of magnitude: ${a} vs ${b}`);
});

test("roster cell: cache WRITES are work and stay in the cell", () => {
  // Pins the cell to workTokens rather than input+output alone: a leaf whose
  // first turn wrote a large cache did that work and the cell must say so.
  const tasks = [{
    id: "warm", model: "opus", state: "ok", durationMs: 1000,
    tokens: tok({ input: 1000, output: 500, cacheCreation: 4000, cacheRead: 50_000_000 }),
  }];
  const block = renderRoster({ title: "t", tasks, now: NOW, startedMs: NOW - 1000 });
  equal(cellFor(block, "warm"), "5.5k");
});

test("roster footer: the run total still counts cacheRead", () => {
  // The regression half: the full figure is right for a run total, so the cell
  // change must not be applied repo-wide. Reddens if :386 moves to workTokens.
  const tasks = [{ id: "claude-impl", model: "opus", state: "ok", durationMs: 1000, tokens: CLAUDE_SHAPED }];
  const block = renderRoster({ title: "t", tasks, now: NOW, startedMs: NOW - 1000 });
  match(footerOf(block), /9M tokens$/);
});

test("estate totals still count cacheRead", () => {
  const run = {
    tasks: [{ id: "a", provider: "anthropic", tokens: CLAUDE_SHAPED }],
    totals: { byState: {} }, waves: [], startedMs: NOW,
  };
  const rows = buildSnapshot("/nonexistent", new Map(), {
    _listRuns: () => [{ dir: "/r/one", project: "p", name: "one", active: false, mtimeMs: 1 }],
    _readRun: () => run,
  }).rows;
  equal(rows[0].tokens, 9_001_500);
  equal(rows[0].providerTokens.anthropic, 9_001_500);
});
