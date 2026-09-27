import { test } from "node:test";
import { deepEqual } from "node:assert/strict";
import { waveDepths, cloneTreeParent } from "../src/waves.mjs";

test("waveDepths keeps forEach clones and their manifest child chain in the parent wave", () => {
  const tasks = [
    { id: "enum", after: [] },
    { id: "chain", after: ["enum"], forEach: { from: "enum" } },
    { id: "chain[0]", after: [], parent: "chain", kind: "container" },
    { id: "chain[0]~walk", after: ["enum"], parent: "chain", kind: "child" },
    { id: "chain[0]~verify", after: ["chain[0]~walk"], parent: "chain", kind: "child" },
    { id: "glossary", after: ["chain[0]~verify"] },
  ];
  const depths = waveDepths(tasks, { parentOf: (task) => cloneTreeParent(task.id) });
  deepEqual(Object.fromEntries(depths), {
    enum: 0, chain: 1, "chain[0]": 1, "chain[0]~walk": 1,
    "chain[0]~verify": 1, glossary: 2,
  });
});

test("waveDepths uses longest after path and ignores unknown edges", () => {
  const tasks = [
    { id: "root" },
    { id: "middle", after: ["root"] },
    { id: "tail", after: ["missing", "middle"] },
  ];
  deepEqual(Object.fromEntries(waveDepths(tasks)), { root: 0, middle: 1, tail: 2 });
});

test("cloneTreeParent finds the forEach behind clones and their children, and nothing for plain manifest children", () => {
  deepEqual(
    ["fix[2]", "chain[0]~walk", "chain[0]~inner~deep", "m~c1", "m~c1[0]", "plain"].map(cloneTreeParent),
    ["fix", "chain", "chain", undefined, "m~c1", undefined],
  );
});
