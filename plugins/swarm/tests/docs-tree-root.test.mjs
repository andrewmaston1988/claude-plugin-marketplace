// The tree-root migration, as the docs promise it. A run dir holds RESULTS; a
// writer's tree is scratch under `treeRoot`, recorded per tree in the run dir.
// Three docs used to place a tree inside the run dir — each must now say where
// it actually lives. README states the layout once; the other two point at it.
import { test } from "node:test";
import { ok } from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const swarm = join(fileURLToPath(import.meta.url), "..", "..");
const read = (rel) => readFileSync(join(swarm, rel), "utf8");

const README = "README.md";
const TOPOLOGY = "skills/executing-swarms/references/topology.md";
const SKILL = "skills/swarm/SKILL.md";

test("README places leaf trees under treeRoot, with a per-tree record", () => {
  const md = read(README);
  ok(md.includes("treeRoot"), "README must name the treeRoot key");
  ok(md.includes("trees/<name>.json"), "README must name the run's per-tree record");
  ok(
    !/leaf worktrees live under `~\/\.swarm\/runs\/`/.test(md),
    "a leaf worktree no longer lives under the runs root — that root holds results",
  );
});

test("README's results layout block carries the record and the scratch root", () => {
  const block = read(README).match(/```\n<resultsDir>\/[\s\S]*?```/)?.[0] || "";
  ok(block, "README must keep its results-layout block");
  ok(block.includes("trees/<name>.json"), `the layout block must list the tree record; got:\n${block}`);
  ok(block.includes("treeRoot"), "the layout block must say where the tree went instead");
});

test("topology.md no longer puts a tree inside the run dir", () => {
  const md = read(TOPOLOGY);
  ok(!/tree lives under the run's/i.test(md), "topology.md still places the tree under the run dir");
  ok(md.includes("treeRoot"), "topology.md must point at the scratch root instead");
});

test("SKILL.md says where a writer's tree lives", () => {
  const md = read(SKILL);
  const line = md.split(/\r?\n/).find((l) => l.startsWith("**The write tools decide where a leaf runs"));
  ok(line, "SKILL.md must keep its writer-tree sentence");
  ok(line.includes("treeRoot"), `the writer-tree sentence must name the scratch root it lives under; got: ${line}`);
});
