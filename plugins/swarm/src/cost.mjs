// Cost history — append-only JSONL at ~/.swarm/usage-history.jsonl, one line per
// live usage fetch that carried measurable weekly segments. `swarm cost` splits
// the lines into weeks and derives each model's per-request meter weight
// (multiplier against the cheapest measured model), so a seat's cost can be
// read beside `swarm perf`'s quality without ever collapsing the two into one
// number.
//
// Storage and derivation share this file: the thin I/O wrappers stay wrappers,
// the maths below them is pure over parsed snapshots.

import { appendFileSync, existsSync, readFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { swarmHome } from "./config.mjs";

export function usageHistoryPath(env = process.env) {
  return join(swarmHome(env), "usage-history.jsonl");
}

// One snapshot per line, one write per snapshot — the same line-atomic contract
// as model-scores.jsonl, so concurrent swarms cannot corrupt the history.
export function appendSnapshot(snapshot, path = usageHistoryPath()) {
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, JSON.stringify(snapshot) + "\n", "utf8");
}

export function readSnapshots(path) {
  if (!existsSync(path)) return [];
  const snaps = [];
  for (const line of readFileSync(path, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      snaps.push(JSON.parse(line));
    } catch {
      // torn tail write from a concurrent append — skip, never abort a query
    }
  }
  return snaps;
}