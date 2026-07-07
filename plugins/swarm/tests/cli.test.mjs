import { test } from "node:test";
import { equal, ok, deepEqual } from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, readdirSync, chmodSync, mkdirSync } from "node:fs";
import { join, delimiter } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync, spawn } from "node:child_process";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";

const CLI = fileURLToPath(new URL("../scripts/swarm.mjs", import.meta.url));
const SHIMS = fileURLToPath(new URL("./shims", import.meta.url));

// POSIX shim needs the exec bit; harmless no-op on Windows.
try { chmodSync(join(SHIMS, "claude"), 0o755); } catch { /* windows */ }

function runCli(args, { cwd, env = {} } = {}) {
  return spawnSync(process.execPath, [CLI, ...args], {
    cwd,
    encoding: "utf8",
    timeout: 60000,
    windowsHide: true,
    env: {
      ...process.env,
      PATH: SHIMS + delimiter + process.env.PATH,
      Path: SHIMS + delimiter + (process.env.Path || process.env.PATH),
      ...env,
    },
  });
}

// Async variant for tests that host a stub HTTP server in THIS process:
// spawnSync would block the event loop and the server could never respond.
function runCliAsync(args, { cwd, env = {} } = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, ...args], {
      cwd,
      windowsHide: true,
      env: {
        ...process.env,
        PATH: SHIMS + delimiter + process.env.PATH,
        Path: SHIMS + delimiter + (process.env.Path || process.env.PATH),
        ...env,
      },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => { stdout += d; });
    child.stderr.on("data", (d) => { stderr += d; });
    child.on("close", (status) => resolve({ status, stdout, stderr }));
  });
}

function tmp() {
  return mkdtempSync(join(tmpdir(), "swarm-cli-"));
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

    // stdout contract: status lines + closing block, never raw output beyond digest path
    ok(r.stdout.includes("✓ scan-a haiku"), r.stdout);
    ok(r.stdout.includes("✓ __digest haiku"), r.stdout);
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
    } else {
      res.writeHead(404).end();
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const home = join(dir, "home");
    mkdirSync(home, { recursive: true });
    writeFileSync(join(home, "config.json"), JSON.stringify({
      provider: { url: `http://127.0.0.1:${server.address().port}` },
    }));
    const r = await runCliAsync(["models"], { cwd: dir, env: { SWARM_HOME: home } });
    equal(r.status, 0, r.stderr);
    ok(r.stdout.includes("glm-5.2:cloud — Frontier open model"), r.stdout);
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

test("status: renders counts, running elapsed, and paths from a synthetic run.log", () => {
  const dir = tmp();
  try {
    const rd = join(dir, "run");
    mkdirSync(join(rd, "results"), { recursive: true });
    const t0 = new Date(Date.now() - 42000).toISOString();
    const lines = [
      { ts: t0, event: "run-start", tasks: ["a", "b", "c", "d", "e", "f"] },
      { ts: t0, id: "a", state: "running" },
      { ts: t0, id: "a", state: "ok" },
      { ts: t0, id: "b", state: "running" },
      { ts: t0, id: "b", state: "failed" },
      { ts: t0, id: "c", state: "blocked" },
      { ts: t0, id: "d", state: "running" },
      { ts: t0, id: "e", state: "rate-limited" },
    ];
    writeFileSync(join(rd, "run.log"), lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
    const r = runCli(["status", rd], { cwd: dir, env: { SWARM_HOME: join(dir, "home") } });
    equal(r.status, 0, r.stderr);
    ok(r.stdout.includes("ok 1 | running 1 | failed 1 | rate-limited 1 | blocked 1 | skipped 0 | pending 1"), r.stdout);
    ok(/d — \d+s elapsed/.test(r.stdout), r.stdout);
    ok(r.stdout.includes(`results: ${join(rd, "results")}`), r.stdout);
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

test("run: default resultsDir lands under .swarm/<stem>-1 with .gitignore", () => {
  const dir = tmp();
  try {
    const manifest = join(dir, "myplan.json");
    writeFileSync(manifest, JSON.stringify({ tasks: [{ id: "a", prompt: "x", model: "haiku" }] }));
    const r = runCli(["run", manifest], { cwd: dir, env: { SWARM_HOME: join(dir, "home") } });
    equal(r.status, 0, r.stderr);
    const rd = join(dir, ".swarm", "myplan-1");
    ok(existsSync(join(rd, "summary.json")), readdirSync(dir).join(","));
    equal(readFileSync(join(rd, ".gitignore"), "utf8"), "*\n");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
