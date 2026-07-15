// Digest report mode, end to end through runPlan. The unit tests pin the prompt
// and the header renderer; these pin the thing that actually has to happen: the
// leaf writes report.md, the ENGINE prepends the provenance header to it, and the
// agent-facing digest.md is unaffected either way.
import { test } from "node:test";
import { equal, ok } from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runPlan } from "../src/scheduler.mjs";
import { buildDigestTask } from "../src/digest.mjs";
import { fakeSpawnFactory, makeIo } from "./helpers/fake-io.mjs";

const tmp = () => mkdtempSync(join(tmpdir(), "swarm-report-"));

const CFG = {
  provider: { mode: "env", url: "http://127.0.0.1:1", authToken: "ollama", allowedRoots: [] },
  concurrency: 4,
  timeoutMs: 600000,
  resultInlineCap: 4000,
  worktreeBranchPrefix: "swarm/",
};

const streamOut = (text, sid) => [
  ...(sid ? [JSON.stringify({ type: "system", subtype: "init", session_id: sid })] : []),
  JSON.stringify({ type: "result", subtype: "success", is_error: false, result: text, usage: { input_tokens: 100, output_tokens: 10 } }),
].join("\n") + "\n";

const leaf = (id, cwd, over = {}) => ({
  id, prompt: `do ${id}`, model: "glm-5.2:cloud", allowedTools: "Read",
  cwd, originalCwd: cwd, scratchRedirect: false, timeoutMs: 5000, after: [],
  ...over,
});

// A plan whose digest task is built the real way, so the prompt under test is the
// one the engine actually ships.
function planWith(dir, report) {
  const tasks = [leaf("scan-a", dir), leaf("scan-b", dir)];
  const p = {
    cwd: dir, resultsDir: join(dir, "run"), concurrency: 4, tasks,
    goal: "find every caller of frobnicate",
    digest: { model: "haiku", instructions: "", ...(report && { report }) },
  };
  p.tasks = [...tasks, buildDigestTask(p)];
  return p;
}

// The digest leaf is the 3rd spawn. `writesReport` simulates a leaf that obeyed
// phase 1 and actually wrote the file.
function spawnFor(dir, { writesReport }) {
  return fakeSpawnFactory((call, i) => {
    if (i === 2 && writesReport) {
      writeFileSync(join(dir, "run", "report.md"), "# Callers of frobnicate\n\nBoth leaves ran.\n");
    }
    return { output: streamOut(i === 2 ? "DIGEST TEXT" : `finding from leaf ${i}`, `s-${i}`) };
  });
}

test("integration: the leaf's title leads; engine APPENDS a one-line run footnote", async () => {
  const dir = tmp();
  try {
    const p = planWith(dir, true);
    const r = await runPlan(p, CFG, makeIo(spawnFor(dir, { writesReport: true })));

    ok(r.reportPath, "runPlan must return the report path");
    const md = readFileSync(r.reportPath, "utf8");

    // the LEAF's own title leads — the engine no longer prepends anything
    ok(md.startsWith("# Callers of frobnicate"), md.slice(0, 120));
    ok(md.includes("Both leaves ran."), "the leaf's body must survive intact");

    // provenance is a single Run footnote at the BOTTOM — no table, no token/cost
    const footAt = md.indexOf("*Run:");
    ok(footAt > md.indexOf("Both leaves ran."), "the Run footnote is at the bottom, after the body");
    ok(md.includes("scan-a") && md.includes("scan-b") && md.includes("glm-5.2:cloud"),
      "the footnote names each leaf and its model");
    ok(!md.includes("## Run") && !md.includes("| leaf |"), "no provenance table");
    ok(!/cache/i.test(md), "no token-accounting footnote in the report");
    ok(!md.includes("__digest"), "the digest node is not in the footnote");

    // the digest is untouched
    equal(readFileSync(join(p.resultsDir, "digest.md"), "utf8").trim(), "DIGEST TEXT");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// THE safety property. The agent path is load-bearing; the human path is not.
test("integration: a digest that writes no report still produces digest.md", async () => {
  const dir = tmp();
  try {
    const p = planWith(dir, true);
    const r = await runPlan(p, CFG, makeIo(spawnFor(dir, { writesReport: false })));

    equal(r.reportPath, null, "no report written → no report path");
    equal(existsSync(join(p.resultsDir, "report.md")), false);
    equal(readFileSync(join(p.resultsDir, "digest.md"), "utf8").trim(), "DIGEST TEXT");
    equal(r.digestFailed, false, "a missing report must not fail the digest");
    // ...but it must not be SILENT either — you asked for a report and got none
    equal(r.reportMissing, true, "a requested-but-absent report must be surfaced");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("integration: without a report block nothing is written and the digest is unchanged", async () => {
  const dir = tmp();
  try {
    const p = planWith(dir, false);
    const r = await runPlan(p, CFG, makeIo(spawnFor(dir, { writesReport: false })));

    equal(r.reportPath ?? null, null);
    equal(existsSync(join(p.resultsDir, "report.md")), false);
    equal(readFileSync(join(p.resultsDir, "digest.md"), "utf8").trim(), "DIGEST TEXT");
    // nothing was asked for, so nothing is missing — no false alarm
    equal(r.reportMissing, false, "a run that never wanted a report must not warn about one");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
