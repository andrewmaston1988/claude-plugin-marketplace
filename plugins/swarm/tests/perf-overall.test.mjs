// `swarm perf --overall` through the real CLI: the needs-grades block, its order,
// its grading gate, its immunity to filters, and the ranked table below it.
import { test } from "node:test";
import { equal, ok, deepEqual } from "node:assert/strict";
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { runCli } from "./helpers/cli.mjs";
import { gateHome, tmp } from "./helpers/cli-fixture.mjs";

const HEADING = "seat one of these on a bounded leaf in your next run — they cannot rank until graded";

const row = (leaf, model, score, domain = "node") => JSON.stringify({
  resultsDir: `C:/runs/${leaf}`, leaf, model, domain, outcome: "completed",
  grades: { adherence: score, handoff: score, truthfulness: score, depth: score },
  note: "", assessedBy: { session: "s1", date: "2026-09-10" },
});
const rowsFor = (model, count, score, domain) => Array.from({ length: count }, (_, i) => row(`${model}-${i}`, model, score, domain));

// glm-5.1 (#1) and kimi-k2 (#2) are graded elders; their successors are young or
// absent; solo has no predecessor; deep is past the canon and needs nothing.
function world({ enabled = true, cache = true } = {}) {
  const dir = tmp();
  const home = gateHome(join(dir, "home"), { grading: { enabled } });
  writeFileSync(join(home, "model-scores.jsonl"), [
    ...rowsFor("glm-5.1:cloud", 6, 9),
    ...rowsFor("glm-5.2:cloud", 2, 8),
    ...rowsFor("kimi-k2:cloud", 6, 7),
    ...rowsFor("solo:cloud", 4, 6),
    ...rowsFor("deep:cloud", 20, 5),
  ].join("\n") + "\n");
  if (cache) {
    writeFileSync(join(home, "models-cache.json"), JSON.stringify({
      updated: "2026-09-10T00:00:00Z",
      models: ["glm-5.1:cloud", "glm-5.2:cloud", "kimi-k2:cloud", "kimi-k3:cloud", "fresh:cloud", "solo:cloud", "deep:cloud"]
        .map((model) => ({ provider: "ollama", model })),
    }));
  }
  return { dir, home };
}

const perf = (w, extra = []) => runCli(["perf", "--overall", ...extra], { cwd: w.dir, env: { SWARM_HOME: w.home } });
const split = (stdout) => {
  const at = stdout.indexOf(HEADING);
  const tableAt = stdout.indexOf("overall  ");
  const lines = stdout.slice(Math.max(at, 0)).split("\n").map((l) => l.trimEnd());
  return { block: at < 0 ? "" : lines.slice(0, lines.indexOf("")).join("\n"), table: stdout.slice(tableAt) };
};

test("perf --overall: the needs-grades block leads, sorted by the elder's standing, chipped, under the seating instruction", () => {
  const w = world();
  try {
    const r = perf(w);
    equal(r.status, 0, r.stderr);
    const { block } = split(r.stdout);
    ok(block, r.stdout);
    const order = [...block.matchAll(/^\s+([a-z0-9.\-]+:cloud)\s/gm)].map((m) => m[1]);
    deepEqual(order, ["glm-5.2:cloud", "kimi-k3:cloud", "fresh:cloud", "solo:cloud"], block);
    ok(block.includes("glm-5.2:cloud  n=2  needs grades — newer generation of glm-5.1:cloud"), block);
    ok(block.includes("kimi-k3:cloud  n=0  needs grades — newer generation of kimi-k2:cloud"), block);
    ok(block.includes("fresh:cloud  needs grades, n=0"), block);
    ok(block.includes("solo:cloud  needs grades, n=4"), block);
    ok(!block.includes("deep:cloud") && !block.includes("glm-5.1:cloud  n="), "past the canon, or an elder, is not asked to be seated");
    ok(r.stdout.indexOf(HEADING) < r.stdout.indexOf("overall  "), "above the ranked table");
  } finally { rmSync(w.dir, { recursive: true, force: true }); }
});

test("perf --overall: a block model is not also listed in the ranked table; elder rows say what replaced them", () => {
  const w = world();
  try {
    const { table } = split(perf(w).stdout);
    ok(!/^\s+glm-5\.2:cloud\s/m.test(table) && !/^\s+solo:cloud\s/m.test(table), table);
    ok(!table.includes("[no grades — outcomes only]"), table);
    ok(/^\s+glm-5\.1:cloud\s.*\[superseded by glm-5\.2:cloud\]/m.test(table), table);
    ok(/^\s+kimi-k2:cloud\s.*\[superseded by kimi-k3:cloud\]/m.test(table), table);
    ok(/^\s+deep:cloud\s/m.test(table) && !/^\s+deep:cloud\s.*superseded/m.test(table), table);
  } finally { rmSync(w.dir, { recursive: true, force: true }); }
});

test("perf --overall: grading off prints no block and leaves the table as it was", () => {
  const w = world({ enabled: false });
  try {
    const r = perf(w);
    equal(r.status, 0, r.stderr);
    ok(!r.stdout.includes(HEADING) && !r.stdout.includes("needs grades"), r.stdout);
    ok(/^\s+glm-5\.2:cloud\s/m.test(r.stdout), "the table still lists every graded model");
  } finally { rmSync(w.dir, { recursive: true, force: true }); }
});

test("perf --overall: no models cache means no roster to name, so no block", () => {
  const w = world({ cache: false });
  try {
    const r = perf(w);
    equal(r.status, 0, r.stderr);
    ok(!r.stdout.includes(HEADING), r.stdout);
  } finally { rmSync(w.dir, { recursive: true, force: true }); }
});

test("perf --overall: --domain and --model never relabel a well-graded model as needing grades", () => {
  const w = world();
  try {
    const plain = split(perf(w).stdout).block;
    ok(plain.includes("glm-5.2:cloud"), "the unfiltered block exists to compare against");
    for (const extra of [["--domain", "other"], ["--model", "deep:cloud"], ["--domain", "node", "--model", "glm-5.1:cloud"]]) {
      const r = perf(w, extra);
      equal(r.status, 0, r.stderr);
      equal(split(r.stdout).block, plain, extra.join(" "));
      ok(!split(r.stdout).block.includes("deep:cloud"), extra.join(" "));
    }
  } finally { rmSync(w.dir, { recursive: true, force: true }); }
});
