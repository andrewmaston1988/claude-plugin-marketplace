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
    deepEqual(summary.truncations, [{ id: "fix", kept: 1, total: 2 }]);
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
