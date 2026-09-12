import { spawnSync, spawn } from "node:child_process";
import { test } from "node:test";
import { equal, ok, deepEqual, match } from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, readdirSync, mkdirSync, utimesSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createServer } from "node:http";
import { runCli, runCliAsync, CLI } from "./helpers/cli.mjs";
import { decide as hookDecide } from "../hooks/ultraswarm.mjs";
import { prepareIsolation } from "../src/worktree.mjs";

function tmp() {
  return mkdtempSync(join(tmpdir(), "swarm-cli-"));
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// A real tiny repo + a real worktree, used to exercise prune end-to-end.
function gitOut(args, cwd) {
  return (spawnSync("git", args, { cwd, encoding: "utf8", windowsHide: true }).stdout || "").trim();
}

function commitAll(cwd, msg) {
  spawnSync("git", ["add", "."], { cwd, windowsHide: true });
  spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", "commit", "-q", "-m", msg], { cwd, windowsHide: true });
}

function initPruneRepo() {
  const repo = mkdtempSync(join(tmpdir(), "swarm-cli-repo-"));
  spawnSync("git", ["init", "-q", "-b", "master"], { cwd: repo, windowsHide: true });
  writeFileSync(join(repo, "a.txt"), "hello\n");
  commitAll(repo, "init");
  return repo;
}

// A run record finished BEFORE the summary was written (so run.log's mtime
// never outgrows summary.json's) — the exact ordering runLiveness trusts.
function writeFinishedRun(resultsDir, worktreesKept) {
  mkdirSync(resultsDir, { recursive: true });
  writeFileSync(join(resultsDir, "run.log"), JSON.stringify({ ts: new Date().toISOString(), event: "run-start", tasks: [{ id: "impl", model: "haiku" }] }) + "\n");
  writeFileSync(join(resultsDir, "summary.json"), JSON.stringify({
    started: new Date().toISOString(),
    finished: new Date().toISOString(),
    tasks: [{ id: "impl", model: "haiku", state: "ok" }],
    blocked: [],
    worktreesKept,
    totalTokens: null,
  }));
}

test("validate: bad manifest exits 1 with readable errors", () => {
  const dir = tmp();
  try {
    const p = join(dir, "bad.json");
    writeFileSync(p, JSON.stringify({
      tasks: [
        { id: "a", prompt: "x", model: "haiku" },
        { id: "a", prompt: "y", model: "haiku", effort: "max" },
        { id: "b", prompt: "{{result:ghost}}", model: "haiku" },
      ],
    }));
    const r = runCli(["validate", p], { cwd: dir, env: { SWARM_HOME: join(dir, "home") } });
    equal(r.status, 1);
    ok(r.stderr.includes("duplicate id"), r.stderr);
    ok(r.stderr.includes("effort 'max'"), r.stderr);
    ok(r.stderr.includes("{{result:ghost}}"), r.stderr);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("validate: good manifest exits 0 and reports task count", () => {
  const dir = tmp();
  try {
    const p = join(dir, "good.json");
    writeFileSync(p, JSON.stringify({
      tasks: [{ id: "a", prompt: "x", model: "haiku" }],
      digest: { model: "haiku" },
    }));
    const r = runCli(["validate", p], { cwd: dir, env: { SWARM_HOME: join(dir, "home") } });
    equal(r.status, 0, r.stderr);
    ok(r.stdout.includes("manifest OK: 1 task(s) + digest"), r.stdout);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// The seats-block rows share a world: a graded store for two models, a models
// cache, and a manifest seating one graded :cloud model and one never-graded
// tier (+ digest). `store` picks a populated store (default), an empty file,
// or none; `corpus` seeds run history so the estimate line reads "estimated ~".
function seatsWorld({ enabled, store = "rows", corpus = false } = {}) {
  const dir = tmp();
  const home = join(dir, "home");
  mkdirSync(home, { recursive: true });
  writeFileSync(join(home, "config.json"), JSON.stringify({
    grading: { enabled },
    provider: { allowedRoots: [tmpdir()] },
  }));
  const row = (leaf, model, grades) => JSON.stringify({
    resultsDir: `C:/runs/${leaf}`, leaf, model, domain: "node", outcome: "completed",
    grades, note: "", assessedBy: { session: "s1", date: "2026-09-10" },
  });
  if (store === "rows") {
    writeFileSync(join(home, "model-scores.jsonl"), [
      row("r1", "glm-5.2:cloud", { adherence: 8, handoff: 8, truthfulness: 8, depth: 8, impl: 7 }),
      row("r2", "glm-5.2:cloud", { adherence: 9, handoff: 7, truthfulness: 8, depth: 8, code: 9 }),
      row("r3", "glm-5.3-flash:cloud", { adherence: 8, handoff: 8, truthfulness: 8, depth: 8 }),
    ].join("\n") + "\n");
  } else if (store === "empty") {
    writeFileSync(join(home, "model-scores.jsonl"), "");
  }
  writeFileSync(join(home, "models-cache.json"), JSON.stringify({
    updated: "2026-09-10T00:00:00Z",
    models: [
      { model: "glm-5.2:cloud", description: "graded" },
      { model: "glm-5.3-flash:cloud", description: "unseated" },
    ],
  }));
  if (corpus) {
    const runDir = join(home, "runs", "some-proj", "old-1");
    mkdirSync(runDir, { recursive: true });
    writeFileSync(join(runDir, "summary.json"), JSON.stringify({
      tasks: [{ id: "a", state: "ok", model: "haiku", tokens: { input: 1000, output: 0, cacheCreation: 0, cacheRead: 0 } }],
    }));
  }
  const manifest = join(dir, "m.json");
  writeFileSync(manifest, JSON.stringify({
    tasks: [
      { id: "lane", prompt: "x", model: "glm-5.2:cloud" },
      { id: "audit", prompt: "y", model: "haiku" },
    ],
    digest: { model: "haiku" },
  }));
  return { dir, home, manifest };
}

// Row 7's byte contract: with the block silent, validate prints exactly its
// three baseline lines and nothing else — no seats header, no trailing roster.
const assertBaselineOutput = (r, label) => {
  equal(r.status, 0, r.stderr);
  const lines = r.stdout.trim().split("\n");
  equal(lines.length, 3, `${label}: ${JSON.stringify(lines)}`);
  equal(lines[0], "manifest OK: 2 task(s) + digest", label);
  equal(lines[1], "estimate: none (no run history yet)", label);
  ok(lines[2].startsWith("resultsDir: "), label);
  ok(!r.stdout.includes("seats:"), label);
};

test("validate: grading.enabled false means no seats block, even with a full store (row 7a)", () => {
  const w = seatsWorld({ enabled: false });
  try {
    assertBaselineOutput(runCli(["validate", w.manifest], { cwd: w.dir, env: { SWARM_HOME: w.home } }), "gate off");
  } finally {
    rmSync(w.dir, { recursive: true, force: true });
  }
});

test("validate: grading on but an empty store stays silent, file or no file (row 7b)", () => {
  for (const store of ["empty", "none"]) {
    const w = seatsWorld({ enabled: true, store });
    try {
      assertBaselineOutput(runCli(["validate", w.manifest], { cwd: w.dir, env: { SWARM_HOME: w.home } }), `store=${store}`);
    } finally {
      rmSync(w.dir, { recursive: true, force: true });
    }
  }
});

test("validate: the seats block sits between the existing lines and never disturbs them; a bad manifest still fails (row 8)", () => {
  const w = seatsWorld({ enabled: true, corpus: true });
  try {
    const r = runCli(["validate", w.manifest], { cwd: w.dir, env: { SWARM_HOME: w.home } });
    equal(r.status, 0, r.stderr);
    ok(r.stdout.includes("manifest OK: 2 task(s) + digest"), r.stdout);
    ok(r.stdout.includes("estimated ~"), r.stdout);
    ok(r.stdout.includes("resultsDir: "), r.stdout);
    // the block's position is the contract: after the approval surface, before
    // the ground truth a session copies.
    const iManifest = r.stdout.indexOf("manifest OK:");
    const iSeats = r.stdout.indexOf("seats:");
    const iResults = r.stdout.indexOf("resultsDir:");
    ok(iManifest >= 0 && iSeats > iManifest && iResults > iSeats, r.stdout);
    // the CLI fed the seam: seated leaf ids, the never-graded digest seat, and
    // the unseated roster model the store has a record for.
    ok(r.stdout.includes("glm-5.2:cloud (lane) · overall"), r.stdout);
    ok(r.stdout.includes("haiku (audit, __digest) · never graded"), r.stdout);
    ok(r.stdout.includes("launchable, not seated: glm-5.3-flash:cloud n=1"), r.stdout);

    // a bad manifest keeps its existing failure: the plan never loads, so the
    // block cannot have printed, and the errors are the manifest's own.
    const bad = join(w.dir, "bad.json");
    writeFileSync(bad, JSON.stringify({
      tasks: [
        { id: "a", prompt: "x", model: "haiku" },
        { id: "a", prompt: "y", model: "haiku" },
      ],
    }));
    const b = runCli(["validate", bad], { cwd: w.dir, env: { SWARM_HOME: w.home } });
    equal(b.status, 1);
    ok(b.stderr.includes("duplicate id"), b.stderr);
    ok(!b.stdout.includes("seats:"), b.stdout);
  } finally {
    rmSync(w.dir, { recursive: true, force: true });
  }
});

test("validate: the store is read once for the block, and not at all while silent (row 9)", () => {
  const register = new URL("./fixtures/store-read-register.mjs", import.meta.url).href;
  const instrumented = (w) => spawnSync(process.execPath, ["--import", register, CLI, "validate", w.manifest], {
    cwd: w.dir,
    encoding: "utf8",
    timeout: 60000,
    windowsHide: true,
    env: { ...process.env, SWARM_HOME: w.home },
  });
  const readCount = (r) => (r.stderr.match(/SWARM_STORE_READ/g) || []).length;

  const populated = seatsWorld({ enabled: true });
  try {
    const r = instrumented(populated);
    equal(r.status, 0, r.stderr);
    equal(readCount(r), 1, `one read for a two-seat manifest:\n${r.stdout}`);
  } finally {
    rmSync(populated.dir, { recursive: true, force: true });
  }
  for (const w of [seatsWorld({ enabled: false }), seatsWorld({ enabled: true, store: "none" })]) {
    try {
      const r = instrumented(w);
      equal(r.status, 0, r.stderr);
      equal(readCount(r), 0, `silent means no read at all:\n${r.stdout}`);
    } finally {
      rmSync(w.dir, { recursive: true, force: true });
    }
  }
});

test("run: 3-task fan-out + digest end-to-end via the claude shim", () => {
  const dir = tmp();
  try {
    const shimLog = join(dir, "shim.log");
    const manifest = join(dir, "sweep.json");
    writeFileSync(manifest, JSON.stringify({
      resultsDir: "out",
      goal: "e2e smoke",
      tasks: [
        { id: "scan-a", prompt: "look a", model: "haiku" },
        { id: "scan-b", prompt: "look b", model: "haiku", effort: "high" },
        { id: "scan-c", prompt: "look c", model: "sonnet" },
      ],
      digest: { model: "haiku", instructions: "focus on X" },
    }));
    const r = runCli(["run", manifest], {
      cwd: dir,
      env: { SWARM_HOME: join(dir, "home"), SWARM_SHIM_LOG: shimLog, SWARM_SHIM_OUTPUT: "leaf-output-text" },
    });
    equal(r.status, 0, `stderr: ${r.stderr}\nstdout: ${r.stdout}`);

    const resultsDir = join(dir, "out");
    // results/<id>.json for all leaves + digest
    for (const id of ["scan-a", "scan-b", "scan-c", "__digest"]) {
      const res = JSON.parse(readFileSync(join(resultsDir, "results", `${id}.json`), "utf8"));
      equal(res.ok, true, id);
      equal(res.output, "leaf-output-text");
    }
    // digest.md written by the ENGINE from digest output
    equal(readFileSync(join(resultsDir, "digest.md"), "utf8"), "leaf-output-text\n");
    // summary.json shape
    const summary = JSON.parse(readFileSync(join(resultsDir, "summary.json"), "utf8"));
    ok(summary.started && summary.finished);
    deepEqual(summary.tasks.map((t) => t.state), ["ok", "ok", "ok", "ok"]);
    deepEqual(summary.blocked, []);
    // run.log is JSONL: run-start + 2 lines per task
    const logLines = readFileSync(join(resultsDir, "run.log"), "utf8").trim().split("\n");
    equal(logLines.length, 9);
    for (const l of logLines) JSON.parse(l);
    // progressive per-leaf logs
    for (const id of ["scan-a", "scan-b", "scan-c", "__digest"]) {
      equal(readFileSync(join(resultsDir, "results", `${id}.log`), "utf8"), "leaf-output-text");
    }
    // .gitignore
    equal(readFileSync(join(resultsDir, ".gitignore"), "utf8"), "*\n");

    // stdout contract: roster snapshots + closing block, never raw output beyond digest path
    ok(/✓ {2}scan-a\s+haiku/.test(r.stdout), r.stdout);
    ok(/✓ {2}__digest\s+haiku/.test(r.stdout), r.stdout);
    ok(r.stdout.includes("4 ok"), r.stdout);
    ok(r.stdout.includes(`digest: ${join(resultsDir, "digest.md")}`), r.stdout);
    ok(r.stdout.includes(`summary: ${join(resultsDir, "summary.json")}`), r.stdout);

    // shim saw the dispatch args: --effort passed for scan-b, models verbatim
    const calls = readFileSync(shimLog, "utf8").trim().split("\n").map((l) => JSON.parse(l));
    equal(calls.length, 4);
    const scanB = calls.find((c) => c.argv[c.argv.indexOf("-p") + 1] === "look b");
    equal(scanB.argv[scanB.argv.indexOf("--effort") + 1], "high");
    const digestCall = calls.find((c) => c.argv[c.argv.indexOf("-p") + 1].includes("digest stage"));
    ok(digestCall, "digest dispatched via claude");
    equal(digestCall.argv[digestCall.argv.indexOf("--allowedTools") + 1], "Read");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("run: failing leaf -> exit 1, FAILED report + resume offer; resume skips ok", () => {
  const dir = tmp();
  try {
    const manifest = join(dir, "plan.json");
    writeFileSync(manifest, JSON.stringify({
      resultsDir: "out",
      tasks: [
        { id: "a", prompt: "x", model: "haiku" },
        { id: "b", prompt: "y", model: "haiku", after: ["a"] },
      ],
    }));
    const env = { SWARM_HOME: join(dir, "home"), SWARM_SHIM_EXIT: "1", SWARM_SHIM_OUTPUT: "boom" };
    const r1 = runCli(["run", manifest], { cwd: dir, env });
    equal(r1.status, 1);
    ok(/✗ {2}a\s+haiku.*\[failed\]/.test(r1.stdout), r1.stdout);
    ok(/⊘ {2}b\s+haiku.*\[blocked\]/.test(r1.stdout), r1.stdout);
    ok(r1.stdout.includes("FAILED tasks:"), r1.stdout);
    ok(r1.stdout.includes("a [failed]"), r1.stdout);
    ok(r1.stdout.includes("b [blocked]"), r1.stdout);
    ok(r1.stdout.toLowerCase().includes("resume"), r1.stdout);

    // resume: shim healthy now — both re-execute (nothing was ok), run passes
    const shimLog = join(dir, "shim2.log");
    const r2 = runCli(["run", manifest], { cwd: dir, env: { SWARM_HOME: join(dir, "home"), SWARM_SHIM_LOG: shimLog } });
    equal(r2.status, 0, r2.stdout + r2.stderr);
    equal(readFileSync(shimLog, "utf8").trim().split("\n").length, 2);

    // third run: everything ok already — all skipped, no dispatches
    const shimLog3 = join(dir, "shim3.log");
    const r3 = runCli(["run", manifest], { cwd: dir, env: { SWARM_HOME: join(dir, "home"), SWARM_SHIM_LOG: shimLog3 } });
    equal(r3.status, 0);
    ok(!existsSync(shimLog3), "no shim calls expected on fully-resumed run");
    ok(r3.stdout.includes("[skipped]"), r3.stdout);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("stop: refuses on a finished run, naming the state", () => {
  const dir = tmp();
  try {
    const manifest = join(dir, "plan.json");
    writeFileSync(manifest, JSON.stringify({
      resultsDir: "out",
      tasks: [{ id: "a", prompt: "x", model: "haiku" }],
    }));
    const env = { SWARM_HOME: join(dir, "home"), SWARM_SHIM_OUTPUT: "done" };
    const r1 = runCli(["run", manifest], { cwd: dir, env });
    equal(r1.status, 0, r1.stderr);
    const resultsDir = join(dir, "out");

    const r2 = runCli(["stop", resultsDir], { cwd: dir, env: { SWARM_HOME: env.SWARM_HOME } });
    equal(r2.status, 1, r2.stdout + r2.stderr);
    ok(r2.stderr.includes("nothing to stop"), r2.stderr);
    ok(r2.stderr.includes("finished"), r2.stderr);
    ok(!existsSync(join(resultsDir, "stop")), "must not write a stop file against a finished run");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("run: refuses a results dir whose engine is alive (fresh heartbeat, no summary) — exit 1, claude never invoked", () => {
  const dir = tmp();
  try {
    const manifest = join(dir, "plan.json");
    writeFileSync(manifest, JSON.stringify({
      resultsDir: "out",
      tasks: [{ id: "a", prompt: "x", model: "haiku" }],
    }));
    const resultsDir = join(dir, "out");
    mkdirSync(resultsDir, { recursive: true });
    const runLog = JSON.stringify({ ts: new Date().toISOString(), event: "run-start", pid: 4321, tasks: [{ id: "a", model: "haiku" }] }) + "\n";
    writeFileSync(join(resultsDir, "run.log"), runLog);
    writeFileSync(join(resultsDir, "heartbeat"), `${new Date().toISOString()} 4321\n`);

    const shimLog = join(dir, "shim.log");
    const r = runCli(["run", manifest], { cwd: dir, env: { SWARM_HOME: join(dir, "home"), SWARM_SHIM_LOG: shimLog } });
    equal(r.status, 1, r.stdout + r.stderr);
    ok(r.stderr.includes(resultsDir), r.stderr);
    ok(r.stderr.includes("4321"), r.stderr);
    ok(r.stderr.includes("swarm stop"), r.stderr);
    ok(!existsSync(shimLog), "claude shim must never be invoked against a live engine");
    equal(readFileSync(join(resultsDir, "run.log"), "utf8"), runLog, "run.log must not gain a second run-start");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("run --force: also refuses a live engine — force is not a bypass", () => {
  const dir = tmp();
  try {
    const manifest = join(dir, "plan.json");
    writeFileSync(manifest, JSON.stringify({
      resultsDir: "out",
      tasks: [{ id: "a", prompt: "x", model: "haiku" }],
    }));
    const resultsDir = join(dir, "out");
    mkdirSync(resultsDir, { recursive: true });
    const runLog = JSON.stringify({ ts: new Date().toISOString(), event: "run-start", pid: 4321, tasks: [{ id: "a", model: "haiku" }] }) + "\n";
    writeFileSync(join(resultsDir, "run.log"), runLog);
    writeFileSync(join(resultsDir, "heartbeat"), `${new Date().toISOString()} 4321\n`);

    const shimLog = join(dir, "shim.log");
    const r = runCli(["run", manifest, "--force"], { cwd: dir, env: { SWARM_HOME: join(dir, "home"), SWARM_SHIM_LOG: shimLog } });
    equal(r.status, 1, r.stdout + r.stderr);
    ok(r.stderr.includes("swarm stop"), r.stderr);
    ok(!existsSync(shimLog), "claude shim must never be invoked against a live engine, even with --force");
    equal(readFileSync(join(resultsDir, "run.log"), "utf8"), runLog, "run.log must not gain a second run-start");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("run: a stale heartbeat (dead engine) is not mistaken for live — resume proceeds", () => {
  const dir = tmp();
  try {
    const manifest = join(dir, "plan.json");
    writeFileSync(manifest, JSON.stringify({
      resultsDir: "out",
      tasks: [{ id: "a", prompt: "x", model: "haiku" }],
    }));
    const resultsDir = join(dir, "out");
    mkdirSync(resultsDir, { recursive: true });
    writeFileSync(join(resultsDir, "run.log"), JSON.stringify({ ts: new Date().toISOString(), event: "run-start", pid: 4321, tasks: [{ id: "a", model: "haiku" }] }) + "\n");
    const hbPath = join(resultsDir, "heartbeat");
    writeFileSync(hbPath, "2020-01-01T00:00:00.000Z 4321\n");
    const anHourAgo = new Date(Date.now() - 60 * 60 * 1000);
    utimesSync(hbPath, anHourAgo, anHourAgo);

    const shimLog = join(dir, "shim.log");
    const r = runCli(["run", manifest], { cwd: dir, env: { SWARM_HOME: join(dir, "home"), SWARM_SHIM_LOG: shimLog, SWARM_SHIM_OUTPUT: "done" } });
    equal(r.status, 0, r.stdout + r.stderr);
    ok(existsSync(shimLog), "a dead engine's results dir must still resume and dispatch");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("run: a fresh results dir (no heartbeat ever written) is not mistaken for live", () => {
  const dir = tmp();
  try {
    const manifest = join(dir, "plan.json");
    writeFileSync(manifest, JSON.stringify({
      resultsDir: "out",
      tasks: [{ id: "a", prompt: "x", model: "haiku" }],
    }));
    const shimLog = join(dir, "shim.log");
    const r = runCli(["run", manifest], { cwd: dir, env: { SWARM_HOME: join(dir, "home"), SWARM_SHIM_LOG: shimLog, SWARM_SHIM_OUTPUT: "done" } });
    equal(r.status, 0, r.stdout + r.stderr);
    ok(existsSync(shimLog), "a never-run results dir must dispatch normally");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("stop: dead engine (stale heartbeat, no summary) — records run-stop and marks non-terminal leaves failed:stopped, touching no process", () => {
  const dir = tmp();
  try {
    const home = join(dir, "home");
    mkdirSync(home, { recursive: true });
    writeFileSync(join(home, "config.json"), JSON.stringify({ heartbeatSecs: 0.1 }));
    const resultsDir = join(dir, "out");
    mkdirSync(resultsDir, { recursive: true });
    const lines = [
      JSON.stringify({ ts: new Date().toISOString(), event: "run-start", tasks: [{ id: "a", model: "haiku" }, { id: "b", model: "haiku" }] }),
      JSON.stringify({ ts: new Date().toISOString(), id: "a", state: "running" }),
    ];
    writeFileSync(join(resultsDir, "run.log"), lines.join("\n") + "\n");

    const r = runCli(["stop", resultsDir], { cwd: dir, env: { SWARM_HOME: home } });
    equal(r.status, 0, r.stdout + r.stderr);
    ok(r.stdout.includes("failed:stopped"), r.stdout);

    const logLines = readFileSync(join(resultsDir, "run.log"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    const stopEvent = logLines.find((l) => l.event === "run-stop");
    ok(stopEvent, "run-stop event must be appended");
    equal(stopEvent.reason, "dead-engine");

    const summary = JSON.parse(readFileSync(join(resultsDir, "summary.json"), "utf8"));
    equal(summary.stopped, true);
    equal(summary.stopReason, "dead-engine");
    deepEqual(summary.tasks.map((t) => t.state).sort(), ["failed:stopped", "failed:stopped"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("stop: live engine via the claude shim writes the stop file, run exits 1, resume re-dispatches the failed:stopped leaf", async () => {
  const dir = tmp();
  let runPromise;
  try {
    const home = join(dir, "home");
    mkdirSync(home, { recursive: true });
    writeFileSync(join(home, "config.json"), JSON.stringify({ heartbeatSecs: 0.5 }));
    const manifest = join(dir, "plan.json");
    writeFileSync(manifest, JSON.stringify({
      resultsDir: "out",
      tasks: [{ id: "slow", prompt: "x", model: "haiku" }],
    }));
    const resultsDir = join(dir, "out");

    runPromise = runCliAsync(["run", manifest], {
      cwd: dir,
      env: { SWARM_HOME: home, SWARM_SHIM_SLEEP_MS: "2000" },
    });

    const deadline = Date.now() + 10000;
    while (!existsSync(join(resultsDir, "heartbeat")) && Date.now() < deadline) await sleep(20);
    ok(existsSync(join(resultsDir, "heartbeat")), "engine must have started ticking before stop is issued");

    const stopResult = runCli(["stop", resultsDir], { cwd: dir, env: { SWARM_HOME: home } });
    equal(stopResult.status, 0, stopResult.stdout + stopResult.stderr);
    ok(stopResult.stdout.includes("stopped"), stopResult.stdout);

    const r1 = await runPromise;
    equal(r1.status, 1, r1.stdout + r1.stderr);
    const summary1 = JSON.parse(readFileSync(join(resultsDir, "summary.json"), "utf8"));
    equal(summary1.stopped, true);
    equal(summary1.tasks.find((t) => t.id === "slow").state, "failed:stopped");

    // resume: the stopped leaf is non-terminal, so it re-dispatches (never skipped)
    const shimLog2 = join(dir, "shim2.log");
    const r2 = runCli(["run", manifest], { cwd: dir, env: { SWARM_HOME: home, SWARM_SHIM_LOG: shimLog2, SWARM_SHIM_OUTPUT: "done" } });
    equal(r2.status, 0, r2.stdout + r2.stderr);
    equal(readFileSync(shimLog2, "utf8").trim().split("\n").length, 1);
  } finally {
    // The child `run` process holds `dir` as its cwd until the shim's sleep
    // elapses and it exits — an rmSync while it's still alive EPERMs on Windows.
    await runPromise?.catch(() => {});
    rmSync(dir, { recursive: true, force: true });
  }
});

test("prune --dry-run: a finished run with a kept worktree prints the table and removes nothing", () => {
  const repo = initPruneRepo();
  const dir = tmp();
  try {
    const resultsDir = join(dir, "out");
    mkdirSync(resultsDir, { recursive: true });
    const wt = prepareIsolation({ id: "impl", originalCwd: repo, cwd: repo }, { worktreeBranchPrefix: "swarm/" }, resultsDir);
    writeFileSync(join(wt.path, "work.txt"), "x\n");
    commitAll(wt.path, "work");
    spawnSync("git", ["merge", "-q", "swarm/impl"], { cwd: repo, windowsHide: true });

    writeFinishedRun(resultsDir, [{ name: "impl", branch: "swarm/impl", path: wt.path }]);

    const r = runCli(["prune", resultsDir, "--dry-run"], { cwd: dir, env: { SWARM_HOME: join(dir, "home") } });
    equal(r.status, 0, r.stdout + r.stderr);
    ok(r.stdout.includes(wt.path), r.stdout);
    ok(r.stdout.includes("swarm/impl"), r.stdout);
    ok(/would free/.test(r.stdout), r.stdout);

    ok(existsSync(wt.path), "dry-run must not remove the worktree");
    ok(gitOut(["branch", "--list", "swarm/impl"], repo), "dry-run must not remove the branch");
  } finally {
    spawnSync("git", ["worktree", "remove", "--force", join(dir, "out", "wt-impl")], { cwd: repo, windowsHide: true });
    rmSync(dir, { recursive: true, force: true });
    rmSync(repo, { recursive: true, force: true });
  }
});

test("prune: removes the worktree and branch, prints freed, leaves the run record untouched", () => {
  const repo = initPruneRepo();
  const dir = tmp();
  try {
    const resultsDir = join(dir, "out");
    mkdirSync(resultsDir, { recursive: true });
    const wt = prepareIsolation({ id: "impl", originalCwd: repo, cwd: repo }, { worktreeBranchPrefix: "swarm/" }, resultsDir);
    writeFileSync(join(wt.path, "work.txt"), "x\n");
    commitAll(wt.path, "work");
    spawnSync("git", ["merge", "-q", "swarm/impl"], { cwd: repo, windowsHide: true });

    writeFinishedRun(resultsDir, [{ name: "impl", branch: "swarm/impl", path: wt.path }]);
    const runLog = readFileSync(join(resultsDir, "run.log"), "utf8");
    const summary = readFileSync(join(resultsDir, "summary.json"), "utf8");

    const r = runCli(["prune", resultsDir], { cwd: dir, env: { SWARM_HOME: join(dir, "home") } });
    equal(r.status, 0, r.stdout + r.stderr);
    ok(/freed [\d.]+ GB across 1 worktree/.test(r.stdout), r.stdout);

    ok(!existsSync(wt.path), "the worktree directory must be gone");
    equal(gitOut(["branch", "--list", "swarm/impl"], repo), "", "the branch must be gone");
    equal(readFileSync(join(resultsDir, "run.log"), "utf8"), runLog, "run.log must survive prune");
    equal(readFileSync(join(resultsDir, "summary.json"), "utf8"), summary, "summary.json must survive prune");
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(repo, { recursive: true, force: true });
  }
});

test("prune: the flag may come first, and a dir with no run.log is an error, not a live run", () => {
  const dir = mkdtempSync(join(tmpdir(), "swarm-prune-args-"));
  try {
    mkdirSync(join(dir, "home"), { recursive: true });
    const missing = join(dir, "home", "runs", "C--proj", "does-not-exist");
    const r = runCli(["prune", "--dry-run", missing], { cwd: dir, env: { SWARM_HOME: join(dir, "home") } });
    equal(r.status, 1, r.stdout + r.stderr);
    ok(/no run at/.test(r.stderr), r.stderr);
    ok(!/live/.test(r.stderr), r.stderr);
    // the flag itself must never be taken as the dir
    ok(!/--dry-run/.test(r.stderr), r.stderr);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("prune: refuses a live run (fresh heartbeat, no summary) — exit 1, nothing removed", () => {
  const repo = initPruneRepo();
  const dir = tmp();
  try {
    const resultsDir = join(dir, "out");
    mkdirSync(resultsDir, { recursive: true });
    const wt = prepareIsolation({ id: "impl", originalCwd: repo, cwd: repo }, { worktreeBranchPrefix: "swarm/" }, resultsDir);
    writeFileSync(join(resultsDir, "run.log"), JSON.stringify({ ts: new Date().toISOString(), event: "run-start", tasks: [{ id: "impl", model: "haiku" }] }) + "\n");
    writeFileSync(join(resultsDir, "heartbeat"), `${new Date().toISOString()} 1234\n`);

    const r = runCli(["prune", resultsDir], { cwd: dir, env: { SWARM_HOME: join(dir, "home") } });
    equal(r.status, 1, r.stdout + r.stderr);
    ok(r.stderr.includes("live — swarm stop it first"), r.stderr);

    ok(existsSync(wt.path), "a live run's worktree must not be touched");
    ok(gitOut(["branch", "--list", "swarm/impl"], repo), "a live run's branch must not be touched");
  } finally {
    spawnSync("git", ["worktree", "remove", "--force", join(dir, "out", "wt-impl")], { cwd: repo, windowsHide: true });
    rmSync(dir, { recursive: true, force: true });
    rmSync(repo, { recursive: true, force: true });
  }
});

test("prune --dry-run: a dead-engine-stopped run with no kept worktree still finds an orphan via manifest.json's cwd", () => {
  const repo = initPruneRepo();
  const dir = tmp();
  try {
    const resultsDir = join(dir, "out");
    mkdirSync(resultsDir, { recursive: true });
    writeFileSync(join(resultsDir, "manifest.json"), JSON.stringify({ resultsDir, cwd: repo, tasks: [] }));
    const wt = prepareIsolation({ id: "impl", originalCwd: repo, cwd: repo }, { worktreeBranchPrefix: "swarm/" }, resultsDir);
    writeFileSync(join(wt.path, "work.txt"), "x\n");
    commitAll(wt.path, "work");
    spawnSync("git", ["merge", "-q", "swarm/impl"], { cwd: repo, windowsHide: true });

    writeFinishedRun(resultsDir, false);

    const r = runCli(["prune", resultsDir, "--dry-run"], { cwd: dir, env: { SWARM_HOME: join(dir, "home") } });
    equal(r.status, 0, r.stdout + r.stderr);
    ok(r.stdout.includes(wt.path), r.stdout);
    ok(r.stdout.includes("swarm/impl"), r.stdout);
    ok(existsSync(wt.path), "dry-run must not remove the worktree");
  } finally {
    spawnSync("git", ["worktree", "remove", "--force", join(dir, "out", "wt-impl")], { cwd: repo, windowsHide: true });
    rmSync(dir, { recursive: true, force: true });
    rmSync(repo, { recursive: true, force: true });
  }
});

test("stop: dead engine discovers a real orphaned worktree via manifest cwd, records it, and prints the prune hint", () => {
  const repo = initPruneRepo();
  const dir = tmp();
  try {
    const home = join(dir, "home");
    mkdirSync(home, { recursive: true });
    writeFileSync(join(home, "config.json"), JSON.stringify({ heartbeatSecs: 0.1 }));
    const resultsDir = join(dir, "out");
    mkdirSync(resultsDir, { recursive: true });
    writeFileSync(join(resultsDir, "manifest.json"), JSON.stringify({ resultsDir, cwd: repo, tasks: [] }));
    const wt = prepareIsolation({ id: "impl", originalCwd: repo, cwd: repo }, { worktreeBranchPrefix: "swarm/" }, resultsDir);

    const lines = [
      JSON.stringify({ ts: new Date().toISOString(), event: "run-start", tasks: [{ id: "impl", model: "haiku" }] }),
      JSON.stringify({ ts: new Date().toISOString(), id: "impl", state: "running" }),
    ];
    writeFileSync(join(resultsDir, "run.log"), lines.join("\n") + "\n");

    const r = runCli(["stop", resultsDir], { cwd: dir, env: { SWARM_HOME: home } });
    equal(r.status, 0, r.stdout + r.stderr);
    ok(r.stdout.includes("failed:stopped"), r.stdout);
    ok(r.stdout.includes(wt.path), r.stdout);
    ok(r.stdout.includes("prune when done"), r.stdout);

    const summary = JSON.parse(readFileSync(join(resultsDir, "summary.json"), "utf8"));
    ok(Array.isArray(summary.worktreesKept), "worktreesKept must be a real array, not hardcoded false");
    equal(summary.worktreesKept.length, 1);
    equal(summary.worktreesKept[0].path, wt.path);
    equal(summary.worktreesKept[0].branch, "swarm/impl");
  } finally {
    spawnSync("git", ["worktree", "remove", "--force", join(dir, "out", "wt-impl")], { cwd: repo, windowsHide: true });
    rmSync(dir, { recursive: true, force: true });
    rmSync(repo, { recursive: true, force: true });
  }
});

// A session had to GUESS the resultsDir and published an invented path
// (".../p5-review-2", which has never existed) as the operator's watch target.
// The engine knows the answer — it must print it, up front, absolutely.
test("run: prints the absolute resultsDir and the watch command at dispatch", () => {
  const dir = tmp();
  try {
    const manifest = join(dir, "banner.json");
    writeFileSync(manifest, JSON.stringify({
      resultsDir: "out",
      tasks: [{ id: "a", prompt: "x", model: "haiku" }],
    }));
    const r = runCli(["run", manifest], {
      cwd: dir,
      env: { SWARM_HOME: join(dir, "home"), SWARM_SHIM_OUTPUT: "done" },
    });
    equal(r.status, 0, r.stderr);
    const resultsDir = join(dir, "out");
    ok(r.stdout.includes(`resultsDir: ${resultsDir}`), r.stdout);
    ok(/watch:.*status .*out.* --watch/.test(r.stdout), `must print a copyable watch command: ${r.stdout}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// A cache replay IS a success — resume-skips-ok is the design and the verification
// loop depends on it. But it printed "finished clean" and a bare digest path, so a
// session skimming the tail read a no-op as a completed fresh round and announced
// "Round 3 is running" when nothing was. Keep exit 0; make the no-op impossible to miss.
test("run: an all-skipped replay still exits 0 but says NOTHING RE-EXECUTED", () => {
  const dir = tmp();
  try {
    const manifest = join(dir, "replay.json");
    writeFileSync(manifest, JSON.stringify({
      resultsDir: "out",
      tasks: [{ id: "a", prompt: "x", model: "haiku" }],
      digest: { model: "haiku" },
    }));
    const env = { SWARM_HOME: join(dir, "home"), SWARM_SHIM_OUTPUT: "first-pass" };
    const r1 = runCli(["run", manifest], { cwd: dir, env });
    equal(r1.status, 0, r1.stderr);
    ok(!r1.stdout.includes("NOTHING RE-EXECUTED"), "a real run must not claim to be a replay");

    // second run: everything is ok on disk already
    const r2 = runCli(["run", manifest], { cwd: dir, env });
    equal(r2.status, 0, "a cache replay is a SUCCESS — results are valid and resume depends on it");
    ok(r2.stdout.includes("NOTHING RE-EXECUTED"), r2.stdout);
    ok(/previous run|PREVIOUS/i.test(r2.stdout), `the digest must be marked as the previous run's: ${r2.stdout}`);
    ok(r2.stdout.includes("--force"), `must name the remedy: ${r2.stdout}`);
    // the replay notice must come BEFORE the digest path, or a tail-skimmer reads
    // the path first and stops there — which is exactly how it was misread.
    ok(r2.stdout.indexOf("NOTHING RE-EXECUTED") < r2.stdout.indexOf("digest:"),
      `the staleness notice must precede the digest path: ${r2.stdout}`);
    ok(r2.stdout.includes("[skipped]"), r2.stdout);

    // --force re-executes and says nothing of the kind
    const r3 = runCli(["run", manifest, "--force"], { cwd: dir, env });
    equal(r3.status, 0);
    ok(!r3.stdout.includes("NOTHING RE-EXECUTED"), r3.stdout);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("models: stub server + SWARM_HOME config -> names with descriptions, aliases, cache", async () => {
  const dir = tmp();
  const server = createServer((req, res) => {
    if (req.url === "/api/experimental/model-recommendations") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({
        recommendations: [
          { model: "glm-5.2:cloud", description: "Frontier open model", context_length: 1000000, max_output_tokens: 131072, required_plan: "pro" },
          { model: "not-cloud:480b", description: "local", context_length: 1, max_output_tokens: 1, required_plan: null },
        ],
      }));
    } else if (req.url === "/api/show") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end("{}");
    } else {
      res.writeHead(404).end();
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const home = join(dir, "home");
    mkdirSync(home, { recursive: true });
    // catalogUrl also points at the stub — the CLI child must never hit the live WAN.
    writeFileSync(join(home, "config.json"), JSON.stringify({
      provider: { url: `http://127.0.0.1:${server.address().port}`, catalogUrl: `http://127.0.0.1:${server.address().port}` },
    }));
    const r = await runCliAsync(["models"], { cwd: dir, env: { SWARM_HOME: home } });
    equal(r.status, 0, r.stderr);
    // ctx from the recommendation, no parameter count from the empty /api/show;
    // the stub 404s /api/generate, so this also pins probe fail-open end to end.
    ok(r.stdout.includes("glm-5.2:cloud — Frontier open model (size unreported, 1.0M ctx)"), r.stdout);
    ok(!r.stdout.includes("not-cloud:480b"), r.stdout);
    for (const alias of ["haiku", "sonnet", "opus"]) {
      ok(r.stdout.includes(alias), `missing alias ${alias}`);
    }
    const cache = JSON.parse(readFileSync(join(home, "models-cache.json"), "utf8"));
    deepEqual(cache.models.map((m) => m.model), ["glm-5.2:cloud"]);
  } finally {
    server.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("models: size-ordered collapsed roster, hidden-count footer, --all resurfaces marked", async () => {
  const dir = tmp();
  const counts = { "glm-5.2:cloud": 756000000000, "glm-5.1:cloud": 355000000000 };
  const generateHits = [];
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => { body += c; });
    req.on("end", () => {
      res.writeHead(200, { "content-type": "application/json" });
      if (req.url === "/api/experimental/model-recommendations") {
        // 5.1 listed first so the size-order assertion tests the sort, not the input order
        res.end(JSON.stringify({
          recommendations: [
            { model: "glm-5.1:cloud", description: "Prior gen", context_length: 202752 },
            { model: "glm-5.2:cloud", description: "Frontier open model", context_length: 1000000 },
          ],
        }));
      } else if (req.url === "/api/show") {
        res.end(JSON.stringify({ model_info: { "general.parameter_count": counts[JSON.parse(body).model] } }));
      } else if (req.url === "/api/generate") {
        generateHits.push(JSON.parse(body).model);
        res.end("{}");
      } else {
        res.end("{}");
      }
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const home = join(dir, "home");
    mkdirSync(home, { recursive: true });
    writeFileSync(join(home, "config.json"), JSON.stringify({
      provider: { url: `http://127.0.0.1:${server.address().port}`, catalogUrl: `http://127.0.0.1:${server.address().port}` },
    }));
    const env = { SWARM_HOME: home };

    const r = await runCliAsync(["models"], { cwd: dir, env });
    equal(r.status, 0, r.stderr);
    ok(r.stdout.includes("glm-5.2:cloud — Frontier open model (756B, 1.0M ctx)"), r.stdout);
    ok(!r.stdout.includes("glm-5.1"), `superseded entry must be hidden by default: ${r.stdout}`);
    ok(r.stdout.includes("1 superseded hidden"), r.stdout);
    ok(r.stdout.includes("--all"), r.stdout);
    // aliases keep the legacy no-parens format; the trailing — is the cost
    // column (an unmeasured Claude tier renders "—", never blank)
    ok(/^sonnet — Claude Sonnet — always available  —$/m.test(r.stdout), r.stdout);
    // probe fired on the refresh path, top-3-visible only — the hidden elder is not probed
    deepEqual(generateHits, ["glm-5.2:cloud"]);
    // cache keeps the full size-ordered roster and carries supersededBy
    const cache = JSON.parse(readFileSync(join(home, "models-cache.json"), "utf8"));
    deepEqual(cache.models.map((m) => m.model), ["glm-5.2:cloud", "glm-5.1:cloud"]);
    equal(cache.models[1].supersededBy, "glm-5.2:cloud");

    const r2 = await runCliAsync(["models", "--all"], { cwd: dir, env });
    equal(r2.status, 0, r2.stderr);
    ok(r2.stdout.includes("glm-5.1:cloud — Prior gen (355B, 203k ctx) [superseded by glm-5.2:cloud]"), r2.stdout);
    ok(!r2.stdout.includes("hidden"), `--all shows everything, no footer: ${r2.stdout}`);
  } finally {
    server.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("quota: prints per-window utilization from the usage endpoint", async () => {
  const dir = tmp();
  const server = createServer((req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({
      limits: [
        { kind: "session", percent: 22, severity: "normal", resets_at: "2026-07-11T12:19:59Z" },
        { kind: "weekly_scoped", percent: 4, severity: "normal", resets_at: "2026-07-18T07:59:59Z", scope: { model: { display_name: "Fable" } } },
      ],
    }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const home = join(dir, "home");
    mkdirSync(home, { recursive: true });
    writeFileSync(join(home, "config.json"), JSON.stringify({ quotaUsageUrl: `http://127.0.0.1:${server.address().port}/usage` }));
    const creds = join(home, "creds.json");
    writeFileSync(creds, JSON.stringify({ claudeAiOauth: { accessToken: "tok" } }));
    const r = await runCliAsync(["quota"], { cwd: dir, env: { SWARM_HOME: home, SWARM_CREDENTIALS: creds } });
    equal(r.status, 0, r.stderr + r.stdout);
    ok(r.stdout.includes("session: 22%"), r.stdout);
    ok(r.stdout.includes("resets 2026-07-11T12:19:59Z"), r.stdout);
    ok(r.stdout.includes("weekly_scoped (Fable): 4%"), r.stdout);
  } finally {
    server.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── headroom (:cloud weekly-allowance preflight): ollama-usage, quota prefix, models, swarm.always ──

// P0 — the incident: a failed live fetch must never render its cached reading
// bare. The banner must precede the first percentage line (index order, not
// presence — a banner underneath the numbers is what the old `usage unread for
// 33h` line already was). The fetch is pointed at a loopback stub via
// provider.cloud.ollama.settingsUrl; no test reaches ollama.com.
test("ollama-usage: P0 an expired cookie prints /!\\ Cookie Expired above the figures", async () => {
  const dir = tmp();
  const server = createServer((req, res) => {
    res.writeHead(303, { location: "https://ollama.com/signin" });
    res.end();
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const home = join(dir, "home");
    mkdirSync(home, { recursive: true });
    writeFileSync(join(home, "config.json"), JSON.stringify({
      provider: { cloud: { ollama: { enabled: true, settingsUrl: `http://127.0.0.1:${server.address().port}/settings` } } },
    }));
    writeFileSync(join(home, "ollama-cookie.json"), "expired-cookie\n");
    writeFileSync(join(home, "ollama-usage.json"), JSON.stringify({
      sessionPctUsed: 3, sessionResetsAt: "2026-09-07T14:49:00Z",
      weeklyPctUsed: 8.1, weeklyResetsAt: "2026-09-12T08:00:00Z",
      fetchedAt: Date.now() - 33 * 3_600_000,
    }));
    const r = await runCliAsync(["ollama-usage"], { cwd: dir, env: { SWARM_HOME: home } });
    const out = r.stdout;
    const bannerAt = out.indexOf("/!\\ Cookie Expired");
    const firstPctLine = out.split("\n").find((l) => l.includes("%"));
    const firstPctAt = firstPctLine === undefined ? -1 : out.indexOf(firstPctLine);
    ok(bannerAt !== -1, `no banner in output:\n${out}`);
    ok(firstPctAt !== -1, `no figures in output:\n${out}`);
    ok(bannerAt < firstPctAt, `banner must precede the first percentage line:\n${out}`);
    ok(out.includes(join(home, "ollama-cookie.json")), `banner must name the swarm cookie path:\n${out}`);
    ok(out.includes("--cookie"), `banner must carry the refresh command:\n${out}`);
    ok(out.includes("ollama weekly: 8.1%"), `cached figures are still shown:\n${out}`);
    equal(r.status, 0, r.stderr + out);
  } finally {
    server.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

// C0 — the subcommand fetches now (gate:false): a healthy run is LIVE, prints
// the two figures and nothing else. The fetch is injected through settingsUrl.
test("ollama-usage: C0 a live fetch prints exactly two provider-named lines, nothing else", async () => {
  const dir = tmp();
  const server = createServer((req, res) => {
    res.writeHead(200, { "content-type": "text/html" });
    res.end(readFileSync(join(import.meta.dirname, "fixtures", "ollama-settings.html"), "utf8"));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const home = join(dir, "home");
    mkdirSync(home, { recursive: true });
    writeFileSync(join(home, "config.json"), JSON.stringify({
      provider: { cloud: { ollama: { enabled: true, settingsUrl: `http://127.0.0.1:${server.address().port}/settings` } } },
    }));
    writeFileSync(join(home, "ollama-cookie.json"), "tok\n");
    const r = await runCliAsync(["ollama-usage"], { cwd: dir, env: { SWARM_HOME: home } });
    equal(r.status, 0, r.stderr + r.stdout);
    deepEqual(r.stdout.trim().split("\n"), [
      "ollama session: 12% — resets 2026-09-06T04:10:00.377393+00:00",
      "ollama weekly: 83.8% — resets 2026-09-12T08:00:00.377418+00:00",
    ]);
    ok(!/cost|\$|request/i.test(r.stdout), r.stdout);
  } finally {
    server.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("quota: C0b every line is prefixed anthropic, not claude", async () => {
  const dir = tmp();
  const server = createServer((req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({
      limits: [
        { kind: "session", percent: 5, severity: "normal", resets_at: "2026-09-06T18:00:00Z" },
        { kind: "weekly_all", percent: 10, severity: "normal", resets_at: "2026-09-07T00:00:00Z" },
        { kind: "weekly_scoped", percent: 3, severity: "normal", resets_at: "2026-09-07T00:00:00Z", scope: { model: { display_name: "Fable" } } },
      ],
    }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const home = join(dir, "home");
    mkdirSync(home, { recursive: true });
    writeFileSync(join(home, "config.json"), JSON.stringify({ quotaUsageUrl: `http://127.0.0.1:${server.address().port}/usage` }));
    const creds = join(home, "creds.json");
    writeFileSync(creds, JSON.stringify({ claudeAiOauth: { accessToken: "tok" } }));
    const r = await runCliAsync(["quota"], { cwd: dir, env: { SWARM_HOME: home, SWARM_CREDENTIALS: creds } });
    equal(r.status, 0, r.stderr + r.stdout);
    const lines = r.stdout.trim().split("\n");
    equal(lines.length, 3, r.stdout);
    for (const l of lines) ok(l.startsWith("anthropic "), l);
    ok(!/\bclaude\b/i.test(r.stdout), r.stdout);
  } finally {
    server.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

// settingsUrl points `models`' meter fetch at this stub; null = the meter is
// unconfigured and every /settings hit gets the catch-all "{}" JSON.
function modelsStubServer(settingsHtml = null) {
  return createServer((req, res) => {
    if (req.url === "/settings" && settingsHtml !== null) {
      res.writeHead(200, { "content-type": "text/html" });
      res.end(settingsHtml);
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    if (req.url === "/api/experimental/model-recommendations") {
      res.end(JSON.stringify({
        recommendations: [{ model: "glm-5.2:cloud", description: "Frontier open model", context_length: 1000000 }],
      }));
    } else {
      res.end("{}");
    }
  });
}

// C1 reads the meter LIVE: the fixture's weekly figure bumped to 100.
const EXHAUSTED_HTML = readFileSync(join(import.meta.dirname, "fixtures", "ollama-settings.html"), "utf8")
  .replace("83.8% used", "100% used").replace("width:83.8%", "width:100%");

test("models: C1 an exhausted meter is named above the :cloud list", async () => {
  const dir = tmp();
  const server = modelsStubServer(EXHAUSTED_HTML);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const home = join(dir, "home");
    mkdirSync(home, { recursive: true });
    writeFileSync(join(home, "config.json"), JSON.stringify({
      provider: {
        url: `http://127.0.0.1:${server.address().port}`,
        catalogUrl: `http://127.0.0.1:${server.address().port}`,
        cloud: { ollama: { enabled: true, settingsUrl: `http://127.0.0.1:${server.address().port}/settings` } },
      },
    }));
    writeFileSync(join(home, "ollama-cookie.json"), "tok\n");
    const r = await runCliAsync(["models"], { cwd: dir, env: { SWARM_HOME: home } });
    equal(r.status, 0, r.stderr);
    ok(r.stdout.includes("exhausted"), r.stdout);
    ok(r.stdout.includes("100%"), r.stdout);
    ok(r.stdout.includes("2026-09-12T08:00:00.377418+00:00"), r.stdout);
    const warnAt = r.stdout.indexOf("exhausted");
    const cloudAt = r.stdout.indexOf("glm-5.2:cloud");
    ok(warnAt >= 0 && cloudAt >= 0 && warnAt < cloudAt, r.stdout);
  } finally {
    server.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("models: C2 false-positive guard — a healthy meter changes nothing", async () => {
  const dir = tmp();
  const server = modelsStubServer(readFileSync(join(import.meta.dirname, "fixtures", "ollama-settings.html"), "utf8"));
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const home = join(dir, "home");
    mkdirSync(home, { recursive: true });
    writeFileSync(join(home, "config.json"), JSON.stringify({
      provider: {
        url: `http://127.0.0.1:${server.address().port}`,
        catalogUrl: `http://127.0.0.1:${server.address().port}`,
        cloud: { ollama: { enabled: true, settingsUrl: `http://127.0.0.1:${server.address().port}/settings` } },
      },
    }));
    writeFileSync(join(home, "ollama-cookie.json"), "tok\n");
    const r = await runCliAsync(["models"], { cwd: dir, env: { SWARM_HOME: home } });
    equal(r.status, 0, r.stderr);
    ok(r.stdout.includes("glm-5.2:cloud — Frontier open model (size unreported, 1.0M ctx)"), r.stdout);
    ok(!/exhausted|⚠|\/!\\/.test(r.stdout), r.stdout);
  } finally {
    server.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("run: C3/C4 swarm.always changes nothing — no ceremony, no new flag, bare dispatch exits 0", () => {
  const dir = tmp();
  try {
    const home = join(dir, "home");
    mkdirSync(home, { recursive: true });
    writeFileSync(join(home, "config.json"), JSON.stringify({ swarm: { always: true } }));
    const manifest = join(dir, "m.json");
    writeFileSync(manifest, JSON.stringify({
      resultsDir: "out",
      tasks: [{ id: "one", prompt: "look", model: "haiku" }],
    }));
    const r = runCli(["run", manifest], { cwd: dir, env: { SWARM_HOME: home, SWARM_SHIM_OUTPUT: "x" } });
    equal(r.status, 0, r.stderr + r.stdout);
    // Exclude path-bearing lines (resultsDir:/watch:/summary:) before matching — an
    // absolute path can contain "gate" (e.g. a worktree named gate-*) without that
    // being the offer-gate/batching/mix-summary prose this test guards against.
    const prose = r.stdout.split("\n").filter((line) => !/^(resultsDir|watch|summary):/.test(line)).join("\n");
    ok(!/gate|batching|mix summary/i.test(prose), prose);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("standing mode: C5 decide() is null outside swarm.always — config absent and explicitly false", async () => {
  const cwd = "C:/code/x";
  equal(await hookDecide({ event: "SessionStart", cwd, config: undefined }), null);
  equal(await hookDecide({ event: "SessionStart", cwd, config: { swarm: { always: false }, provider: { allowedRoots: ["C:/code"] } } }), null);
});

test("unknown command and missing args exit 1 with usage", () => {
  const dir = tmp();
  try {
    const r = runCli(["frobnicate"], { cwd: dir, env: { SWARM_HOME: join(dir, "home") } });
    equal(r.status, 1);
    ok(r.stderr.includes("usage:"));
    const r2 = runCli(["run"], { cwd: dir, env: { SWARM_HOME: join(dir, "home") } });
    equal(r2.status, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("status: renders the roster with counts, elapsed, tokens from a synthetic run.log", () => {
  const dir = tmp();
  try {
    const rd = join(dir, "run");
    mkdirSync(join(rd, "results"), { recursive: true });
    const t0 = new Date(Date.now() - 42000).toISOString();
    const lines = [
      { ts: t0, event: "run-start", tasks: [{ id: "a", model: "haiku" }, { id: "b", model: "glm-5.2:cloud" }, { id: "c", model: "haiku" }, { id: "d", model: "haiku" }, { id: "e", model: "haiku" }, { id: "f", model: "haiku" }] },
      { ts: t0, id: "a", state: "running" },
      { ts: t0, id: "a", state: "ok", durationMs: 30000, tokens: { input: 1000, output: 500, cacheCreation: 0, cacheRead: 0 } },
      { ts: t0, id: "b", state: "running" },
      { ts: t0, id: "b", state: "failed" },
      { ts: t0, id: "c", state: "blocked" },
      { ts: t0, id: "d", state: "running" },
      { ts: t0, id: "d", event: "tokens", tokens: { input: 2000, output: 100, cacheCreation: 0, cacheRead: 0 } },
      { ts: t0, id: "e", state: "rate-limited" },
    ];
    writeFileSync(join(rd, "run.log"), lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
    writeFileSync(join(rd, "heartbeat"), "live\n"); // a live engine
    const r = runCli(["status", rd], { cwd: dir, env: { SWARM_HOME: join(dir, "home") } });
    equal(r.status, 0, r.stderr);
    ok(r.stdout.includes("1 ok · 1 failed · 1 rate-limited · 1 blocked · 1 running · 1 pending"), r.stdout);
    ok(/✓ {2}a\s+haiku\s+30s\s+1\.5k/.test(r.stdout), r.stdout);
    ok(/◐ {2}d\s+haiku\s+\d+s\s+2\.1k/.test(r.stdout), r.stdout); // live elapsed + live tokens
    ok(r.stdout.includes("3.6k tokens"), r.stdout);
    ok(r.stdout.includes(`results: ${join(rd, "results")}`), r.stdout);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("run: stream-json shim -> tokens flow to roster, closing block, and summary", () => {
  const dir = tmp();
  try {
    const manifest = join(dir, "tok.json");
    writeFileSync(manifest, JSON.stringify({
      resultsDir: "out",
      tasks: [
        { id: "t1", prompt: "x", model: "haiku" },
        { id: "t2", prompt: "y", model: "haiku" },
      ],
    }));
    const r = runCli(["run", manifest], {
      cwd: dir,
      env: { SWARM_HOME: join(dir, "home"), SWARM_SHIM_STREAM: "1", SWARM_SHIM_OUTPUT: "answer text" },
    });
    equal(r.status, 0, r.stderr + r.stdout);
    // result text extracted from the result event, not raw JSONL
    for (const id of ["t1", "t2"]) {
      const res = JSON.parse(readFileSync(join(dir, "out", "results", `${id}.json`), "utf8"));
      equal(res.output, "answer text");
      equal(res.tokens.input, 1200);
      equal(res.costUsd, 0.01);
    }
    // roster shows per-leaf 1.5k and total 3k; closing block totals in/out
    ok(/✓ {2}t1\s+haiku\s+\d+s\s+1\.5k/.test(r.stdout), r.stdout);
    ok(r.stdout.includes("3k tokens"), r.stdout);
    ok(r.stdout.includes("tokens: 3k (input 2.4k · output 600)"), r.stdout);
    const summary = JSON.parse(readFileSync(join(dir, "out", "summary.json"), "utf8"));
    deepEqual(summary.totalTokens, { input: 2400, output: 600, cacheCreation: 0, cacheRead: 0 });

    // ask: resume t1's captured session with a follow-up
    const shimLog = join(dir, "ask-shim.log");
    const a = runCli(["ask", join(dir, "out"), "t1", "why?"], {
      cwd: dir,
      env: { SWARM_HOME: join(dir, "home"), SWARM_SHIM_STREAM: "1", SWARM_SHIM_OUTPUT: "because X", SWARM_SHIM_LOG: shimLog },
    });
    equal(a.status, 0, a.stderr + a.stdout);
    ok(a.stdout.includes("because X"), a.stdout);
    ok(a.stdout.includes("tokens: 1.5k"), a.stdout);
    const askCall = JSON.parse(readFileSync(shimLog, "utf8").trim());
    equal(askCall.argv[askCall.argv.indexOf("--resume") + 1], "shim-session");
    ok(readFileSync(join(dir, "out", "results", "t1.ask.log"), "utf8").includes("because X"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("run: forEach expands end-to-end via the shim; validate previews worst-case leaves; truncation is loud", () => {
  const dir = tmp();
  try {
    const manifest = join(dir, "fan.json");
    writeFileSync(manifest, JSON.stringify({
      resultsDir: "out",
      tasks: [
        { id: "src", prompt: "list", model: "haiku" },
        {
          id: "fix", prompt: "fix {{item.f}} #{{index}}", model: "haiku", after: ["src"],
          forEach: { from: "src", path: "sites", maxItems: 1 },
        },
      ],
    }));

    const v = runCli(["validate", manifest], { cwd: dir, env: { SWARM_HOME: join(dir, "home") } });
    equal(v.status, 0, v.stderr);
    ok(v.stdout.includes("worst case: up to 2 leaves"), v.stdout);
    ok(v.stdout.includes("fix ≤ 1"), v.stdout);

    const r = runCli(["run", manifest], {
      cwd: dir,
      env: { SWARM_HOME: join(dir, "home"), SWARM_SHIM_OUTPUT: '{"sites":[{"f":"a"},{"f":"b"}]}' },
    });
    equal(r.status, 0, r.stderr + r.stdout);
    const rd = join(dir, "out");
    const clone = JSON.parse(readFileSync(join(rd, "results", "fix[0].json"), "utf8"));
    equal(clone.ok, true);
    ok(!existsSync(join(rd, "results", "fix[1].json")), "capped clone must not exist");
    const parent = JSON.parse(readFileSync(join(rd, "results", "fix.json"), "utf8"));
    equal(parent.clones, 1);
    deepEqual(parent.truncated, { kept: 1, total: 2 });
    ok(/fix\[0\]/.test(r.stdout), r.stdout); // clone row in the roster
    ok(r.stdout.includes("first 1 of 2"), r.stdout); // closing-block truncation line
    const summary = JSON.parse(readFileSync(join(rd, "summary.json"), "utf8"));
    deepEqual(summary.truncations, [{ kind: "forEach", id: "fix", kept: 1, total: 2 }]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("status: missing run.log reports cleanly", () => {
  const dir = tmp();
  try {
    const r = runCli(["status", join(dir, "nope")], { cwd: dir, env: { SWARM_HOME: join(dir, "home") } });
    equal(r.status, 0);
    ok(r.stdout.includes("no run.log"), r.stdout);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("run: default resultsDir lands under <home>/runs/<encoded-cwd>/<stem>-1 with .gitignore", () => {
  const dir = tmp();
  try {
    const manifest = join(dir, "myplan.json");
    writeFileSync(manifest, JSON.stringify({ tasks: [{ id: "a", prompt: "x", model: "haiku" }] }));
    const r = runCli(["run", manifest], { cwd: dir, env: { SWARM_HOME: join(dir, "home") } });
    equal(r.status, 0, r.stderr);
    const rd = join(dir, "home", "runs", dir.replace(/[\\/:]/g, "-"), "myplan-1");
    ok(existsSync(join(rd, "summary.json")), readdirSync(dir).join(","));
    equal(readFileSync(join(rd, ".gitignore"), "utf8"), "*\n");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("validate: returns schemas join the approval preview; malformed ones exit 1", () => {
  const dir = tmp();
  try {
    const p = join(dir, "ret.json");
    writeFileSync(p, JSON.stringify({
      tasks: [
        { id: "scan", prompt: "x", model: "haiku", returns: { type: "object", required: ["sites"], properties: { sites: { type: "array" } } } },
        { id: "sum", prompt: "y {{result:scan}}", model: "haiku", after: ["scan"] },
      ],
    }));
    const v = runCli(["validate", p], { cwd: dir, env: { SWARM_HOME: join(dir, "home") } });
    equal(v.status, 0, v.stderr);
    ok(v.stdout.includes("returns validated: scan"), v.stdout);
    ok(v.stdout.includes("one corrective re-ask"), v.stdout);

    const bad = join(dir, "bad-ret.json");
    writeFileSync(bad, JSON.stringify({
      tasks: [{ id: "a", prompt: "x", model: "haiku", returns: { type: "list" } }],
    }));
    const b = runCli(["validate", bad], { cwd: dir, env: { SWARM_HOME: join(dir, "home") } });
    equal(b.status, 1);
    ok(b.stderr.includes("type 'list' is not supported"), b.stderr);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("validate: estimate line from a seeded corpus; cold start says none", () => {
  const dir = tmp();
  try {
    const home = join(dir, "home");
    const runDir = join(home, "runs", "some-proj", "old-1");
    mkdirSync(runDir, { recursive: true });
    writeFileSync(join(runDir, "summary.json"), JSON.stringify({
      tasks: [
        { id: "a", state: "ok", model: "haiku", tokens: { input: 1000, output: 0, cacheCreation: 0, cacheRead: 0 } },
        { id: "b", state: "ok", model: "haiku", tokens: { input: 2000, output: 0, cacheCreation: 0, cacheRead: 0 } },
        { id: "c", state: "ok", model: "haiku", tokens: { input: 3000, output: 0, cacheCreation: 0, cacheRead: 0 } },
      ],
    }));
    const p = join(dir, "plan.json");
    writeFileSync(p, JSON.stringify({
      tasks: [
        { id: "x", prompt: "a", model: "haiku" },
        { id: "y", prompt: "b", model: "haiku" },
      ],
    }));
    const v = runCli(["validate", p], { cwd: dir, env: { SWARM_HOME: home } });
    equal(v.status, 0, v.stderr);
    ok(v.stdout.includes("estimated ~4k tokens"), v.stdout); // median 2000 × 2 leaves

    const cold = runCli(["validate", p], { cwd: dir, env: { SWARM_HOME: join(dir, "empty-home") } });
    equal(cold.status, 0, cold.stderr);
    ok(cold.stdout.includes("estimate: none (no run history yet)"), cold.stdout);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("run: closing tokens line compares actual vs estimate; projection warn reaches stdout", () => {
  const dir = tmp();
  try {
    const home = join(dir, "home");
    const runDir = join(home, "runs", "seed", "r-1");
    mkdirSync(runDir, { recursive: true });
    // median 1000/leaf; shim leaves actually burn 1500 each
    writeFileSync(join(runDir, "summary.json"), JSON.stringify({
      tasks: [{ id: "s", state: "ok", model: "haiku", tokens: { input: 1000, output: 0, cacheCreation: 0, cacheRead: 0 } }],
    }));
    const cfgPath = join(dir, "config.json");
    writeFileSync(cfgPath, JSON.stringify({ costWarnTokens: 100 }));
    const p = join(dir, "plan.json");
    writeFileSync(p, JSON.stringify({
      resultsDir: "out",
      tasks: [
        { id: "x", prompt: "a", model: "haiku" },
        { id: "y", prompt: "b", model: "haiku" },
      ],
    }));
    const r = runCli(["run", p], {
      cwd: dir,
      env: { SWARM_HOME: home, SWARM_CONFIG: cfgPath, SWARM_SHIM_STREAM: "1" },
    });
    equal(r.status, 0, r.stderr + r.stdout);
    ok(r.stdout.includes("estimated ~2k tokens"), r.stdout);          // 2 leaves × median 1000
    ok(r.stdout.includes("estimate was ~2k (50% over)"), r.stdout);   // actual 3k vs 2k
    ok(r.stdout.includes("projected"), r.stdout);                     // warn crossed the tiny threshold
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("validate: composed leaves multiply into the worst case; child errors exit 1 prefixed", () => {
  const dir = tmp();
  try {
    writeFileSync(join(dir, "child.json"), JSON.stringify({
      tasks: [
        { id: "scan", prompt: "scan {{item}}", model: "haiku" },
        { id: "sum", prompt: "sum {{result:scan}}", model: "haiku", after: ["scan"] },
      ],
    }));
    const p = join(dir, "parent.json");
    writeFileSync(p, JSON.stringify({
      tasks: [
        { id: "seed", prompt: "list", model: "haiku" },
        { id: "audit", manifest: "child.json", after: ["seed"], forEach: { from: "seed", path: "", maxItems: 3 } },
      ],
    }));
    const v = runCli(["validate", p], { cwd: dir, env: { SWARM_HOME: join(dir, "home") } });
    equal(v.status, 0, v.stderr);
    ok(v.stdout.includes("up to 7 leaves"), v.stdout);               // 1 + 3×2
    ok(v.stdout.includes("audit ≤ 3 × 2 child leaves"), v.stdout);   // composition detail

    writeFileSync(join(dir, "bad-child.json"), JSON.stringify({ tasks: [{ id: "scan", model: "haiku" }] }));
    const bad = join(dir, "bad-parent.json");
    writeFileSync(bad, JSON.stringify({ tasks: [{ id: "audit", manifest: "bad-child.json" }] }));
    const b = runCli(["validate", bad], { cwd: dir, env: { SWARM_HOME: join(dir, "home") } });
    equal(b.status, 1);
    ok(b.stderr.includes("task 'audit' -> child 'scan'"), b.stderr);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── W1: named manifests + args ────────────────────────────────────────────────

test("validate: registry name resolves and announces the lookup; --resolved prints the substituted manifest", () => {
  const dir = tmp();
  try {
    const home = join(dir, "home");
    mkdirSync(join(home, "manifests"), { recursive: true });
    const saved = join(home, "manifests", "w1-smoke.json");
    writeFileSync(saved, JSON.stringify({
      tasks: [{ id: "a", prompt: "say {{args.word}}", model: "haiku" }],
    }));
    const r = runCli(["validate", "w1-smoke", "--args", '{"word":"hello"}', "--resolved"], {
      cwd: dir, env: { SWARM_HOME: home },
    });
    equal(r.status, 0, `stderr: ${r.stderr}\nstdout: ${r.stdout}`);
    ok(r.stdout.startsWith(`resolved: w1-smoke → ${saved} (global)`), r.stdout);
    const marker = "resolved manifest:";
    const at = r.stdout.indexOf(marker);
    ok(at >= 0, r.stdout);
    const doc = JSON.parse(r.stdout.slice(at + marker.length));
    equal(doc.tasks[0].prompt, "say hello");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("validate: path invocation prints no resolved line (byte-compatible with today)", () => {
  const dir = tmp();
  try {
    const p = join(dir, "plain.json");
    writeFileSync(p, JSON.stringify({ tasks: [{ id: "a", prompt: "x", model: "haiku" }] }));
    const r = runCli(["validate", p], { cwd: dir, env: { SWARM_HOME: join(dir, "home") } });
    equal(r.status, 0, r.stderr);
    ok(!r.stdout.includes("resolved:"), r.stdout);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("--args must be a JSON object — teaching error with example", () => {
  const dir = tmp();
  try {
    const p = join(dir, "plain.json");
    writeFileSync(p, JSON.stringify({ tasks: [{ id: "a", prompt: "x", model: "haiku" }] }));
    for (const bad of ["notjson", "[1]", '"str"']) {
      const r = runCli(["validate", p, "--args", bad], { cwd: dir, env: { SWARM_HOME: join(dir, "home") } });
      equal(r.status, 1, `--args ${bad} should fail`);
      ok(r.stderr.includes('{"base":"master"}'), r.stderr);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("list: both scopes shown with names + scopes; collisions loud; exit 0", () => {
  const dir = tmp();
  try {
    const home = join(dir, "home");
    mkdirSync(join(home, "manifests"), { recursive: true });
    mkdirSync(join(dir, ".swarm", "manifests"), { recursive: true });
    const body = JSON.stringify({ goal: "g", tasks: [{ id: "a", prompt: "x", model: "haiku" }] });
    writeFileSync(join(dir, ".swarm", "manifests", "local-a.json"), body);
    writeFileSync(join(home, "manifests", "glob-b.json"), body);
    writeFileSync(join(dir, ".swarm", "manifests", "dup.json"), body);
    writeFileSync(join(home, "manifests", "dup.json"), body);
    const r = runCli(["list"], { cwd: dir, env: { SWARM_HOME: home } });
    equal(r.status, 0, r.stderr);
    ok(r.stdout.includes("local-a"), r.stdout);
    ok(r.stdout.includes("glob-b"), r.stdout);
    ok(r.stdout.includes("local"), r.stdout);
    ok(r.stdout.includes("global"), r.stdout);
    ok(/collision/i.test(r.stdout), r.stdout);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("run: named manifest end-to-end — args substituted into the dispatched leaf prompt", () => {
  const dir = tmp();
  try {
    const home = join(dir, "home");
    mkdirSync(join(home, "manifests"), { recursive: true });
    writeFileSync(join(home, "manifests", "w1-run.json"), JSON.stringify({
      resultsDir: "out",
      tasks: [{ id: "a", prompt: "say {{args.word}}", model: "haiku" }],
    }));
    const shimLog = join(dir, "w1-shim.log");
    const r = runCli(["run", "w1-run", "--args", '{"word":"hello"}'], {
      cwd: dir, env: { SWARM_HOME: home, SWARM_SHIM_LOG: shimLog },
    });
    equal(r.status, 0, `stderr: ${r.stderr}\nstdout: ${r.stdout}`);
    const call = JSON.parse(readFileSync(shimLog, "utf8").trim());
    equal(call.argv[call.argv.indexOf("-p") + 1], "say hello");
    const res = JSON.parse(readFileSync(join(dir, "out", "results", "a.json"), "utf8"));
    equal(res.ok, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("report: writes report.html beside report.md and prints the path", () => {
  const dir = tmp();
  try {
    const resultsDir = join(dir, "run");
    mkdirSync(resultsDir, { recursive: true });
    writeFileSync(join(resultsDir, "report.md"),
      "# Findings — the subject\n\n## PROVEN / OPEN ledger\n\n**PROVEN**\n\n- **PROVEN** fact one — foo.gd:1\n\n**OPEN**\n\n- **OPEN** claim two\n");
    const r = runCli(["report", resultsDir], { cwd: dir, env: { SWARM_HOME: join(dir, "home") } });
    equal(r.status, 0, `stderr: ${r.stderr}\nstdout: ${r.stdout}`);
    const htmlPath = join(resultsDir, "report.html");
    ok(existsSync(htmlPath), "report.html written");
    ok(r.stdout.includes(htmlPath), "path printed to stdout");
    const html = readFileSync(htmlPath, "utf8");
    ok(html.includes("<!doctype html>"), "self-contained document");
    ok(html.includes('class="badge b-proven"'), "verdict badge upgraded");
    ok(html.includes('class="cite">foo.gd:1'), "citation upgraded");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("report: missing report.md exits 1 with a readable error", () => {
  const dir = tmp();
  try {
    const resultsDir = join(dir, "run");
    mkdirSync(resultsDir, { recursive: true });
    const r = runCli(["report", resultsDir], { cwd: dir, env: { SWARM_HOME: join(dir, "home") } });
    equal(r.status, 1);
    ok(r.stderr.toLowerCase().includes("report.md"), r.stderr);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("serve: dashboard.enabled=false refuses to start (foreground and --daemon), names the key, writes no pid", () => {
  const dir = tmp();
  try {
    const home = join(dir, "home");
    mkdirSync(home, { recursive: true });
    writeFileSync(join(home, "config.json"), JSON.stringify({ dashboard: { enabled: false, port: 0 } }));
    for (const args of [["serve"], ["serve", "--daemon"]]) {
      const r = runCli(args, { cwd: dir, env: { SWARM_HOME: home } });
      equal(r.status, 0, r.stderr);
      ok(/dashboard: disabled/.test(r.stdout), r.stdout);
      ok(r.stdout.includes("dashboard.enabled"), r.stdout);
      ok(!existsSync(join(home, "dashboard.pid")), "no pid file");
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("config init: writes every shipped key into ~/.swarm/config.json, keeps set values, reports added keys", () => {
  const dir = tmp();
  try {
    const home = join(dir, "home");
    let r = runCli(["config", "init"], { cwd: dir, env: { SWARM_HOME: home } });
    equal(r.status, 0, r.stderr);
    ok(r.stdout.includes(join(home, "config.json")), r.stdout);
    ok(/created/.test(r.stdout), r.stdout);
    const on = JSON.parse(readFileSync(join(home, "config.json"), "utf8"));
    equal(on.swarm.always, false);
    on.provider.allowedRoots = ["C:/code"];
    delete on.dashboard.port;
    writeFileSync(join(home, "config.json"), JSON.stringify(on));
    r = runCli(["config", "init"], { cwd: dir, env: { SWARM_HOME: home } });
    equal(r.status, 0, r.stderr);
    ok(/added 1 key.*dashboard.port/.test(r.stdout), r.stdout);
    const after = JSON.parse(readFileSync(join(home, "config.json"), "utf8"));
    deepEqual(after.provider.allowedRoots, ["C:/code"]);
    equal(after.dashboard.port, 7331);
    r = runCli(["config"], { cwd: dir, env: { SWARM_HOME: home } });
    equal(r.status, 1, "bare config is not a verb");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("run: the closing block asks for grading only when grading.enabled is true", () => {
  for (const enabled of [false, true]) {
    const dir = tmp();
    try {
      const home = join(dir, "home");
      mkdirSync(home, { recursive: true });
      writeFileSync(join(home, "config.json"), JSON.stringify({ grading: { enabled } }));
      const manifest = join(dir, "m.json");
      writeFileSync(manifest, JSON.stringify({
        resultsDir: "out",
        goal: "grading gate",
        tasks: [{ id: "one", prompt: "look", model: "haiku" }],
      }));
      const r = runCli(["run", manifest], { cwd: dir, env: { SWARM_HOME: home, SWARM_SHIM_OUTPUT: "x" } });
      equal(r.status, 0, r.stderr);
      equal(/awaiting grading/.test(r.stdout), enabled, `enabled=${enabled}\n${r.stdout}`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

// digest.md is the one file a dispatching session reads, so the grading ask must
// reach it — once, only while grading is on and the run has no store rows.
test("run: digest.md carries exactly one grade footer while the run is ungraded, and none once graded or with grading off", () => {
  const footers = (d) => (readFileSync(join(d, "out", "digest.md"), "utf8").match(/awaiting grading/g) || []).length;
  const setup = (enabled) => {
    const dir = tmp();
    const home = join(dir, "home");
    mkdirSync(home, { recursive: true });
    writeFileSync(join(home, "config.json"), JSON.stringify({ grading: { enabled } }));
    const manifest = join(dir, "m.json");
    writeFileSync(manifest, JSON.stringify({
      resultsDir: "out", goal: "digest footer",
      tasks: [{ id: "one", prompt: "look", model: "haiku" }, { id: "two", prompt: "look", model: "haiku" }],
      digest: { model: "haiku", instructions: "" },
    }));
    const run = () => runCli(["run", manifest], { cwd: dir, env: { SWARM_HOME: home, SWARM_SHIM_OUTPUT: "x" } });
    return { dir, home, run };
  };
  const on = setup(true);
  try {
    equal(on.run().status, 0);
    equal(footers(on.dir), 1, "ungraded: one footer");
    const replay = on.run();
    equal(replay.status, 0);
    equal(footers(on.dir), 1, "a cached replay rewrites, never doubles");
    // backslashes: the store's rows are canonicalised, not string-matched
    writeFileSync(join(on.home, "model-scores.jsonl"), JSON.stringify({ resultsDir: join(on.dir, "out").replaceAll("/", "\\"), leaf: "one" }) + "\n");
    const graded = on.run();
    equal(footers(on.dir), 0, "graded: the replay's digest carries no footer");
    ok(!/awaiting grading/.test(graded.stdout), `graded: the closing block stays silent\n${graded.stdout}`);
  } finally { rmSync(on.dir, { recursive: true, force: true }); }
  const off = setup(false);
  try {
    equal(off.run().status, 0);
    equal(footers(off.dir), 0, "grading off: no footer");
  } finally { rmSync(off.dir, { recursive: true, force: true }); }
});

test("A5: grade --waive needs a non-empty reason; writes the waiver file; store rows unchanged", () => {
  const dir = tmp();
  try {
    const home = join(dir, "home");
    mkdirSync(home, { recursive: true });
    const resultsDir = join(dir, "out");
    mkdirSync(join(resultsDir, "results"), { recursive: true });
    writeFileSync(join(resultsDir, "results", "one.json"), JSON.stringify({ id: "one", model: "haiku", ok: true }));
    writeFileSync(join(home, "model-scores.jsonl"), JSON.stringify({ resultsDir, leaf: "other" }) + "\n");
    const before = readFileSync(join(home, "model-scores.jsonl"), "utf8");

    const noReason = runCli(["grade", "--waive", resultsDir], { cwd: dir, env: { SWARM_HOME: home } });
    equal(noReason.status, 1, noReason.stdout + noReason.stderr);
    match(noReason.stderr, /--reason/);
    ok(!existsSync(join(resultsDir, "grade-waiver.json")), "no waiver written without a reason");

    const r = runCli(["grade", "--waive", resultsDir, "--reason", "smoke"], { cwd: dir, env: { SWARM_HOME: home } });
    equal(r.status, 0, r.stderr);
    const waiverFile = join(resultsDir, "grade-waiver.json");
    ok(existsSync(waiverFile), r.stdout);
    const body = JSON.parse(readFileSync(waiverFile, "utf8"));
    equal(body.reason, "smoke");
    ok(typeof body.waivedAt === "string" && !Number.isNaN(Date.parse(body.waivedAt)));
    ok(r.stdout.includes("grade-waiver.json"), r.stdout);

    equal(readFileSync(join(home, "model-scores.jsonl"), "utf8"), before, "waiving never appends a store row");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("statusline install: writes the self-resolving shim into ~/.swarm and prints the settings.json line; the shim runs the installed plugin's bar", () => {
  const dir = tmp();
  try {
    const home = join(dir, "home");
    const r = runCli(["statusline", "install"], { cwd: dir, env: { SWARM_HOME: home } });
    equal(r.status, 0, r.stderr);
    const shim = join(home, "statusline.mjs");
    ok(existsSync(shim), "shim written");
    ok(r.stdout.includes('"statusLine"'), r.stdout);
    ok(r.stdout.includes(shim.replaceAll("\\", "/")), "forward-slash path in the snippet");
    // Without it the harness repaints only on conversation updates: an idle session's bar freezes.
    ok(/"refreshInterval": \d+/.test(r.stdout), r.stdout);
    // a fake registry whose installPath is THIS working tree: the shim must resolve through it
    const registry = join(dir, "installed_plugins.json");
    const pluginRoot = join(import.meta.dirname, "..");
    writeFileSync(registry, JSON.stringify({ plugins: { "swarm@andrewmaston1988-claude-plugins": [{ scope: "user", installPath: pluginRoot, lastUpdated: "2026-09-05T00:00:00Z" }] } }));
    const out = spawnSync(process.execPath, [shim], { encoding: "utf8", input: "{}", env: { ...process.env, SWARM_HOME: home, SWARM_PLUGIN_REGISTRY: registry } });
    equal(out.status, 0, out.stderr);
    equal(out.stdout, "\n", "no live runs → blank bar, exit 0");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// The bug (2026-09-12): `serve restart` against a LIVE daemon on the CURRENTLY
// installed version hit the `blocksStart` already-running short-circuit — meant
// for `start` only — before ever reaching the `verb === "restart"` kill/wait/
// respawn path. A live daemon on the current version is exactly the tray's
// Restart button case, and it did nothing.
test("serve restart: a live daemon on the current version is killed and replaced, never short-circuited as already-running", async () => {
  const dir = tmp();
  const home = join(dir, "home");
  mkdirSync(home, { recursive: true });
  writeFileSync(join(home, "config.json"), JSON.stringify({
    dashboard: { enabled: true, port: 0, bind: "127.0.0.1", tray: false, autoRestartOnUpdate: false },
  }));
  const version = "v-restart-test";
  const registry = join(dir, "installed_plugins.json");
  writeFileSync(registry, JSON.stringify({
    plugins: { "swarm@andrewmaston1988-claude-plugins": [{ scope: "user", installPath: dir, version, lastUpdated: "2026-09-12T00:00:00Z" }] },
  }));
  const { writePid, readPid, isAlive, waitForExit } = await import("../src/serve/daemon.mjs");

  // A real, long-lived process standing in for the old daemon — isAlive/kill must
  // observe a real pid, not a fake one that was never running.
  const sleeper = spawn(process.execPath, ["-e", "setInterval(()=>{},1e9)"], { stdio: "ignore" });
  await new Promise((resolve, reject) => { sleeper.once("spawn", resolve); sleeper.once("error", reject); });
  let daemonPid = null;
  try {
    // version matches the registry above → NOT stale, so this is the "already
    // running, current version" case the short-circuit wrongly caught.
    writePid(home, { pid: sleeper.pid, port: 0, version, listening: true, startedMs: Date.now() });

    // cwd is the OS tmpdir, not `dir`: the replacement daemon inherits it, and a
    // daemon cwd'd inside `dir` locks that directory on Windows until well after
    // the killed process's pid stops answering isAlive, turning cleanup to EPERM.
    // Async, not runCli's spawnSync: on POSIX the killed sleeper is OUR child, and a
    // blocked event loop never reaps it — the zombie keeps answering kill(pid, 0) and
    // restart aborts with "the old daemon did not exit" (Linux CI).
    const r = await runCliAsync(["serve", "restart"], { cwd: tmpdir(), env: { SWARM_HOME: home, SWARM_PLUGIN_REGISTRY: registry } });
    equal(r.status, 0, r.stdout + r.stderr);
    ok(!/already running/.test(r.stdout), `restart must never short-circuit as already-running:\n${r.stdout}`);
    ok(r.stdout.includes(`stopped pid ${sleeper.pid}`), r.stdout);
    ok(!isAlive(sleeper.pid), "the old daemon must actually be killed");

    const rec = readPid(home);
    ok(rec?.pid && rec.pid !== sleeper.pid, `a replacement daemon must be recorded: ${JSON.stringify(rec)}`);
    daemonPid = rec.pid;
    ok(r.stdout.includes(`restarted pid ${rec.pid}`), r.stdout);
  } finally {
    // Wait for actual exit before rmSync — a killed-but-not-yet-reaped process
    // still holds its log file open on Windows and turns cleanup into EPERM.
    if (daemonPid && isAlive(daemonPid)) {
      try { process.kill(daemonPid); } catch { /* already gone */ }
      await waitForExit(daemonPid, { sleep: (ms) => new Promise((r) => setTimeout(r, ms)) });
    }
    if (isAlive(sleeper.pid)) {
      try { process.kill(sleeper.pid); } catch { /* already gone */ }
      await waitForExit(sleeper.pid, { sleep: (ms) => new Promise((r) => setTimeout(r, ms)) });
    }
    rmSync(dir, { recursive: true, force: true });
  }
});
