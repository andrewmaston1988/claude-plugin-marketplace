// One finished run mixing a subscription Claude leaf, a Codex leaf and a `:cloud` leaf, which
// every surface pin in run-cost*.test.mjs reads. The result files' `costUsd` is the runner's
// unfiltered figure and no surface may price from it.
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { snap, seg } from "./cost-snapshots.mjs";

export const PROJECT = "C--code-mix";
export const NAME = "mixed-1";
export const DEFAULT_TEXT = "3.2% of week";
// claude $0.32 + codex $0.35 api-eq; glm 32 turns x 0.1 pts/request.
export const MONEY_TEXT = "≈$0.67 api-eq · 3.2% of week";

const CLAUDE_TOKENS = { input: 100_000, output: 24_000, cacheCreation: 0, cacheRead: 1_000_000 };
const CODEX_TOKENS = { input: 1_000_000, output: 400_000, cacheCreation: 0, cacheRead: 5_000_000 };
const CLOUD_TOKENS = { input: 500_000, output: 10_000, cacheCreation: 0, cacheRead: 0 };

const LEAVES = [
  { id: "claude-leaf", model: "claude-haiku-4-5-20251001", provider: "claude", runner: "claude", tokens: CLAUDE_TOKENS, numTurns: 9, costUsd: 0.9 },
  { id: "codex-leaf", model: "gpt-6-luna", provider: "codex", runner: "codex", tokens: CODEX_TOKENS, numTurns: 4 },
  { id: "cloud-leaf", model: "glm-5.3:cloud", provider: "ollama", runner: "claude", tokens: CLOUD_TOKENS, numTurns: 32, costUsd: 2.18 },
];

const line = (o) => JSON.stringify(o);

export function mixedCostHome({ money = false } = {}) {
  const home = mkdtempSync(join(tmpdir(), "swarm-mixed-cost-"));
  const dir = join(home, "runs", PROJECT, NAME);
  mkdirSync(join(dir, "results"), { recursive: true });
  const ts = (s) => `2026-09-29T01:00:${String(s).padStart(2, "0")}Z`;
  const log = [
    line({ ts: ts(0), event: "run-start", tasks: LEAVES.map(({ id, model, provider, runner }) => ({ id, model, provider, runner })) }),
    ...LEAVES.flatMap((l, i) => [
      line({ ts: ts(1 + i), id: l.id, state: "running", provider: l.provider, runner: l.runner }),
      line({ ts: ts(10 + i), id: l.id, state: "ok", durationMs: 9000, tokens: l.tokens, numTurns: l.numTurns, provider: l.provider, runner: l.runner }),
    ]),
  ].join("\n") + "\n";
  writeFileSync(join(dir, "run.log"), log, "utf8");
  writeFileSync(join(dir, "manifest.json"), JSON.stringify({ tasks: LEAVES.map(({ id, model }) => ({ id, model, prompt: `do ${id}` })) }), "utf8");
  writeFileSync(join(dir, "summary.json"), JSON.stringify({
    started: ts(0), finished: ts(20),
    tasks: LEAVES.map(({ id, model, provider, tokens, numTurns }) => ({ id, model, provider, state: "ok", tokens, numTurns })),
  }), "utf8");
  for (const l of LEAVES) {
    writeFileSync(join(dir, "results", `${l.id}.json`), JSON.stringify({ ...l, ok: true, exit: 0, durationMs: 9000, prompt: `do ${l.id}`, output: "done" }), "utf8");
  }
  // 50% of the week used, 20% of it by glm over 100 requests: 0.1 points a request.
  writeFileSync(join(home, "usage-history.jsonl"), JSON.stringify(snap("2026-09-01T00:00:00.000Z", [seg("glm-5.3", 100, 20)], 50)) + "\n", "utf8");
  if (money) writeFileSync(join(home, "config.json"), JSON.stringify({ display: { money: true } }), "utf8");
  return { home, dir, project: PROJECT, name: NAME };
}

// What the engine writes for a leaf: the row `leafCost` prices.
export const leafRow = (id) => {
  const { id: _id, runner: _runner, costUsd: _cost, ...row } = LEAVES.find((l) => l.id === id);
  return { id, ...row };
};
