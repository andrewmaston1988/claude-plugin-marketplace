import { test } from "node:test";
import { equal, deepEqual, ok } from "node:assert/strict";
import { join } from "node:path";
import { buildDigestTask, DIGEST_ID } from "../src/digest.mjs";
import { resultPath } from "../src/results.mjs";

const plan = (over = {}) => ({
  cwd: "C:/work",
  resultsDir: "C:/work/.swarm/run-1",
  goal: "find every caller of frobnicate",
  tasks: [
    { id: "scan-a", model: "glm-4.6:cloud", timeoutMs: 600000 },
    { id: "scan-b", model: "glm-4.6:cloud", timeoutMs: 900000 },
    { id: "join", model: "haiku", timeoutMs: 600000 },
  ],
  digest: { model: "minimax-m3:cloud", instructions: "must_be_sure: the panel auth path" },
  ...over,
});

test("digest task depends on ALL leaves and uses the plan's digest model", () => {
  const t = buildDigestTask(plan());
  equal(t.id, DIGEST_ID);
  deepEqual(t.after, ["scan-a", "scan-b", "join"]);
  equal(t.model, "minimax-m3:cloud");
  equal(t.cwd, "C:/work");
  equal(t.isDigest, true);
  equal(t.timeoutMs, 900000); // widest leaf timeout
});

// A verifier fed a truncated finding-set checked only a PREFIX. Without this the
// digest promotes the unchecked remainder as if a verifier had confirmed it —
// which is how a fabricated finding reached the operator on p5-review round 5.
test("digest is told to treat a truncated leaf input as unverified", () => {
  const t = buildDigestTask(plan());
  ok(t.prompt.includes("promptTruncations"), "digest must know the field name to look for");
  ok(/prefix/i.test(t.prompt), "digest must be told the leaf saw only a prefix");
  ok(/OPEN/.test(t.prompt) && /never PROVEN|not PROVEN/i.test(t.prompt),
    "digest must be told such findings are OPEN, never PROVEN");
});

test("digest leaf is read-only — the ENGINE writes digest.md", () => {
  const t = buildDigestTask(plan());
  equal(t.allowedTools, "Read");
  ok(t.prompt.includes("Do not write any files"));
  ok(t.prompt.includes("the engine writes digest.md"));
});

test("template contains goal, every result path, and the compression markers", () => {
  const p = plan();
  const t = buildDigestTask(p);
  ok(t.prompt.includes("find every caller of frobnicate"));
  for (const leaf of p.tasks) {
    ok(t.prompt.includes(resultPath(p.resultsDir, leaf.id)), `missing path for ${leaf.id}`);
  }
  ok(t.prompt.includes("≤5"));
  ok(t.prompt.includes("PROVEN / OPEN ledger"));
  ok(t.prompt.includes("Drill-down"));
  ok(t.prompt.includes("headlines first"));
  ok(t.prompt.includes("must_be_sure"));
  ok(t.prompt.toLowerCase().includes("account for every leaf"));
});

test("manifest digest.instructions are appended verbatim", () => {
  const t = buildDigestTask(plan());
  ok(t.prompt.includes("must_be_sure: the panel auth path"));
  const noInstr = buildDigestTask(plan({ digest: { model: "haiku" } }));
  ok(!noInstr.prompt.includes("Additional instructions"));
});

test("missing goal falls back to an explicit placeholder", () => {
  const t = buildDigestTask(plan({ goal: "" }));
  ok(t.prompt.includes("(no goal line provided in the manifest)"));
});
