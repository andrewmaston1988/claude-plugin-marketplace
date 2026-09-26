// Digest report mode, end to end through runPlan. The unit tests pin the prompt
// and the header renderer; these pin the thing that actually has to happen: the
// leaf writes report.md, the ENGINE prepends the provenance header to it, and the
// agent-facing digest.md is unaffected either way.
import { test } from "node:test";
import { deepEqual, equal, ok } from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { runPlan } from "../src/scheduler.mjs";
import { buildDigestTask, scratchPath, DIGEST_ID } from "../src/digest.mjs";
import { writeResult } from "../src/results.mjs";
import { normalizeForCompare } from "../src/roots.mjs";
import { addDirsOf, fakeSpawnFactory, makeIo } from "./helpers/fake-io.mjs";

const SHIM = fileURLToPath(new URL("./shims/codex-shim.mjs", import.meta.url));

const tmp = () => mkdtempSync(join(tmpdir(), "swarm-report-"));

const CFG = {
  provider: { mode: "env", url: "http://127.0.0.1:1", authToken: "ollama", allowedRoots: [] },
  // allowedRoots gates Claude too now; every fixture lives under tmpdir.
  providers: { claude: { enabled: true, allowedRoots: [tmpdir()] } },
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
  id, prompt: `do ${id}`, provider: "ollama", model: "glm-5.2:cloud", allowedTools: "Read",
  cwd, originalCwd: cwd, timeoutMs: 5000, after: [],
  ...over,
});

// A plan whose digest task is built the real way, so the prompt under test is the
// one the engine actually ships.
function planWith(dir, report) {
  const tasks = [leaf("scan-a", dir), leaf("scan-b", dir)];
  const p = {
    cwd: dir, resultsDir: join(dir, "run"), concurrency: 4, tasks,
    goal: "find every caller of frobnicate",
    digest: { provider: "claude", model: "claude-haiku-4-5-20251001", instructions: "", ...(report && { report }) },
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

// ── Codex report mode, end to end ─────────────────────────────────────────────

const CODEX_CFG = {
  ...CFG,
  providers: {
    claude: { enabled: true, allowedRoots: [tmpdir()] },
    codex: { enabled: true, path: "codex", sandbox: "workspace-write", allowedRoots: [tmpdir()] },
  },
};

const CODEX_DIGEST_TEXT = "CODEX DIGEST TEXT";

// Same real buildDigestTask, dispatched through the Codex runner instead.
function codexPlanWith(dir, report) {
  const tasks = [leaf("scan-a", dir), leaf("scan-b", dir)];
  const p = {
    cwd: dir, resultsDir: join(dir, "run"), concurrency: 4, tasks,
    goal: "find every caller of frobnicate",
    digest: { provider: "codex", model: "gpt-5-codex", instructions: "", ...(report && { report }) },
  };
  p.tasks = [...tasks, buildDigestTask(p)];
  return p;
}

// Driven through the REAL codex shim, so the shim adjudicates the emitted argv, and
// it writes report.md only where --add-dir granted access — a wrong grant cannot pass.
function codexSpawn(dir, { writesReport = true, output = CODEX_DIGEST_TEXT } = {}) {
  const shimRuns = [];
  const reportFile = join(dir, "run", "report.md");
  const spawn = fakeSpawnFactory((call) => {
    if (!call.args.includes("exec")) return { output: streamOut(`finding from leaf`, `s-${shimRuns.length}`) };
    const granted = addDirsOf(call.args);
    const reportDir = normalizeForCompare(dirname(reportFile));
    const permitted = granted.some((d) => normalizeForCompare(d) === reportDir);
    const shim = spawnSync(process.execPath, [SHIM, ...call.args], {
      encoding: "utf8", cwd: call.opts.cwd, env: { ...process.env, SWARM_CODEX_SHIM_OUTPUT: output },
    });
    shimRuns.push({
      call, granted, permitted, cwdExisted: existsSync(call.opts.cwd),
      status: shim.status, stderr: shim.stderr, spawnError: shim.error?.message ?? null,
    });
    if (writesReport && permitted) writeFileSync(reportFile, "# Callers of frobnicate\n\nBoth leaves ran.\n");
    return { output: shim.stdout, exit: shim.status };
  });
  return { spawn, shimRuns };
}

const digestCallOf = (spawn) => spawn.calls.find((c) => c.args.includes("exec"));

test("Codex integration: the digest launches from its scratch cwd and writes digest.md from real JSONL", async () => {
  const dir = tmp();
  try {
    const p = codexPlanWith(dir, true);
    const { spawn, shimRuns } = codexSpawn(dir);
    const r = await runPlan(p, CODEX_CFG, makeIo(spawn));

    equal(shimRuns.length, 1, "the digest's emitted argv must run the shim exactly once");
    // The shim runs IN the digest's cwd, so this is the launch that `codex exec`
    // would make: the directory has to be there, not merely named.
    ok(shimRuns[0].cwdExisted, `the digest's cwd must exist when codex launches: ${shimRuns[0].call.opts.cwd}`);
    equal(shimRuns[0].status, 0, `codex could not start: ${shimRuns[0].spawnError || shimRuns[0].stderr}`);

    const call = digestCallOf(spawn);
    equal(call.cmd, "codex");
    equal(call.opts.cwd, scratchPath(p.resultsDir), "the digest drafts in its own scratch directory");

    // The provider translation, asserted on the argv the run actually used. The
    // exact directory matters: --add-dir is what makes the report writable, so a
    // directory that merely exists would leave the artifact to the fake's whim.
    equal(call.args[call.args.indexOf("--sandbox") + 1], "workspace-write");
    deepEqual(shimRuns[0].granted, [p.resultsDir], "the results dir is the digest's one writable directory");
    ok(shimRuns[0].permitted, "the report path must fall under a directory the argv granted");
    ok(call.args.includes("--skip-git-repo-check"), call.args.join(" "));
    ok(!call.args.includes("--settings"), `Codex must never receive Claude settings: ${call.args.join(" ")}`);

    equal(readFileSync(join(p.resultsDir, "digest.md"), "utf8").trim(), CODEX_DIGEST_TEXT);
    equal(r.digestFailed, false);
    equal(r.reportMissing, false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("Codex integration: the report carries the leaf's title and the engine's run footnote", async () => {
  const dir = tmp();
  try {
    const p = codexPlanWith(dir, true);
    const { spawn } = codexSpawn(dir);
    const r = await runPlan(p, CODEX_CFG, makeIo(spawn));

    ok(r.reportPath, "runPlan must return the report path");
    const md = readFileSync(r.reportPath, "utf8");
    ok(md.startsWith("# Callers of frobnicate"), md.slice(0, 120));
    ok(md.indexOf("*Run:") > md.indexOf("Both leaves ran."), "the Run footnote is at the bottom");
    ok(md.includes("scan-a") && md.includes("scan-b"), "the footnote names each leaf");
    ok(!md.includes(DIGEST_ID), "the digest node is not in the footnote");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// No report block means a read-only digest: it keeps the repo-root gate it does
// not need to leave, so it gets no writable directory and no launch allowance.
test("Codex integration: a read-only digest configuration stays read-only end to end", async () => {
  const dir = tmp();
  try {
    const p = codexPlanWith(dir, false);
    const { spawn, shimRuns } = codexSpawn(dir, { writesReport: false });
    const r = await runPlan(p, CODEX_CFG, makeIo(spawn));

    equal(shimRuns[0].status, 0, shimRuns[0].stderr);
    const call = digestCallOf(spawn);
    equal(call.opts.cwd, dir, "a read-only digest reads the dispatching repo in place");
    equal(call.args[call.args.indexOf("--sandbox") + 1], "read-only");
    deepEqual(shimRuns[0].granted, [], "a read-only digest has nothing to make writable");
    ok(!call.args.includes("--skip-git-repo-check"), call.args.join(" "));
    ok(!call.args.includes("--settings"), call.args.join(" "));

    equal(readFileSync(join(p.resultsDir, "digest.md"), "utf8").trim(), CODEX_DIGEST_TEXT);
    equal(r.reportPath ?? null, null);
    equal(r.reportMissing, false, "nothing was asked for, so nothing is missing");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// The failed audit's shape, reproduced: the six leaves completed, __digest died
// with durationMs 0 and the provider-settings rejection. A resume must re-dispatch
// ONLY the digest and land both artifacts.
test("Codex integration: resume re-dispatches only the failed digest", async () => {
  const dir = tmp();
  try {
    const p = codexPlanWith(dir, true);
    mkdirSync(join(p.resultsDir, "results"), { recursive: true });
    for (const t of p.tasks.filter((t) => t.id !== DIGEST_ID)) {
      writeResult(p.resultsDir, t.id, {
        id: t.id, model: t.model, provider: t.provider, ok: true, exit: 0, durationMs: 12,
        output: `finding from ${t.id}`, sessionId: `s-${t.id}`,
      });
    }
    writeResult(p.resultsDir, DIGEST_ID, {
      id: DIGEST_ID, model: "gpt-5-codex", provider: "codex", ok: false, exit: null, durationMs: 0,
      output: "dispatch error: provider 'codex' rejected task: Codex tasks do not accept Claude-only settings",
      errorCode: "DISPATCH_ERROR",
    });

    const { spawn, shimRuns } = codexSpawn(dir);
    const r = await runPlan(p, CODEX_CFG, makeIo(spawn));

    equal(spawn.calls.length, 1, `only the digest may re-dispatch: ${spawn.calls.map((c) => c.cmd).join(", ")}`);
    ok(shimRuns[0].cwdExisted, `the resumed digest's cwd must exist: ${shimRuns[0].call.opts.cwd}`);
    equal(shimRuns[0].status, 0, shimRuns[0].spawnError || shimRuns[0].stderr);
    equal(digestCallOf(spawn).opts.cwd, scratchPath(p.resultsDir));
    deepEqual(shimRuns[0].granted, [p.resultsDir], "the resumed dispatch grants the same directory");
    const resumed = r.summary.tasks.filter((t) => t.state === "skipped").map((t) => t.id);
    equal(resumed.length, p.tasks.length - 1, `every successful leaf stays skipped: ${resumed.join(", ")}`);
    ok(readFileSync(join(p.resultsDir, "digest.md"), "utf8").includes(CODEX_DIGEST_TEXT));
    ok(existsSync(join(p.resultsDir, "report.md")), "the report the failed run never produced");
    equal(r.digestFailed, false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
