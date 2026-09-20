import { test } from "node:test";
import { deepEqual, equal, ok } from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import http from "node:http";
import { fixtureRegistry, fixtureRunner, FIXTURE_MODEL } from "./fixtures/fourth-provider.mjs";
import { refreshModelsCache, readModelsCache, writeCompositeModelsCache } from "../src/discovery.mjs";
import { loadManifest, effectivePlanDoc } from "../src/manifest.mjs";
import { buildDispatch, createDispatchRegistry } from "../src/dispatch.mjs";
import { runPlan } from "../src/scheduler.mjs";
import { makeIo, fakeSpawnFactory } from "./helpers/fake-io.mjs";
import { readCachedUsage } from "../src/usage.mjs";
import { cmdModels, cmdUsage, readProviderUsage } from "../scripts/swarm.mjs";
import { runCli } from "./helpers/cli.mjs";
import { readRunLog } from "../src/runlog.mjs";
import { readResult, readSummary } from "../src/results.mjs";
import { buildSnapshot } from "../src/serve/estate.mjs";
import { createServer } from "../src/serve/server.mjs";
import { costView } from "../src/serve/perf-views.mjs";
import { identityLabel } from "../statusline/swarm-statusline.mjs";

function config(root) {
  return {
    providers: {
      claude: { enabled: true },
      ollama: { enabled: false, allowedRoots: [] },
      codex: { enabled: false, allowedRoots: [] },
      fixture: { enabled: true, allowedRoots: [root] },
    },
    concurrency: 1,
  };
}

function getJson(server, path) {
  return new Promise((resolve, reject) => {
    http.get({ host: "127.0.0.1", port: server.address().port, path }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => { body += chunk; });
      res.on("end", () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(body) }); }
        catch (error) { reject(error); }
      });
    }).on("error", reject);
  });
}

test("a fourth provider crosses discovery, usage, manifest, scheduler, persistence, grading, CLI, and UI consumers", async () => {
  const home = mkdtempSync(join(tmpdir(), "swarm-fourth-provider-"));
  const root = join(home, "repo");
  mkdirSync(root, { recursive: true });
  // Runs are filed under the dispatching repo's toplevel, so a non-repo cwd is refused.
  spawnSync("git", ["init", "-q"], { cwd: root, windowsHide: true });
  // A default read-only leaf snapshots its repo, and a commit-less repo cannot be snapshotted.
  writeFileSync(join(root, "seed.txt"), "seed");
  spawnSync("git", ["add", "."], { cwd: root, windowsHide: true });
  spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", "commit", "-q", "-m", "init"], { cwd: root, windowsHide: true });
  const manifest = join(root, "manifest.json");
  // loadManifest takes no env, so without an explicit resultsDir the run home
  // resolves against the real ~/.swarm.
  writeFileSync(manifest, JSON.stringify({ resultsDir: join(home, "run"), tasks: [{ id: "inspect", model: FIXTURE_MODEL, prompt: "inspect" }] }));
  const cfg = config(root);
  const env = { ...process.env, SWARM_HOME: home };
  const registry = fixtureRegistry();
  try {
    const refreshed = await refreshModelsCache({ config: cfg, env, registry, providers: ["fixture"] });
    deepEqual(readModelsCache(env).models, refreshed.models);
    equal(refreshed.models[0].provider, "fixture");

    const plan = loadManifest(manifest, cfg, root, { providerRegistry: registry, cache: refreshed.models });
    equal(plan.tasks[0].provider, "fixture");
    equal(effectivePlanDoc(plan).tasks[0].provider, "fixture");

    const dispatch = createDispatchRegistry({ providerRegistry: registry });
    dispatch.runnerRegistry.register(fixtureRunner());
    const invocation = buildDispatch(plan.tasks[0], plan.tasks[0].prompt, cfg, {
      providerRegistry: registry,
      runnerRegistry: dispatch.runnerRegistry,
      cache: refreshed.models,
    });
    equal(invocation.provider, "fixture");
    equal(invocation.runner, "fixture");

    const usage = await readCachedUsage(cfg, { providerRegistry: registry, env });
    equal(usage.find((row) => row.provider === "fixture").state, "ok");
    const liveUsage = await readProviderUsage(cfg, { registry, env });
    deepEqual(liveUsage.errors, {});
    equal(liveUsage.usages.find((row) => row.provider === "fixture").state, "ok");

    const spawn = fakeSpawnFactory(() => ({ output: "fixture output" }));
    const run = await runPlan(plan, cfg, makeIo(spawn, { env }), {
      providerRegistry: registry,
      runnerRegistry: dispatch.runnerRegistry,
    });
    equal(run.summary.tasks.find((row) => row.id === "inspect").state, "ok");
    equal(spawn.calls[0].cmd, "fixture-runner");
    equal(readResult(plan.resultsDir, "inspect").provider, "fixture");
    equal(readResult(plan.resultsDir, "inspect").runner, "fixture");
    equal(readSummary(plan.resultsDir).tasks[0].provider, "fixture");

    const parsed = readRunLog(readFileSync(join(plan.resultsDir, "run.log"), "utf8"));
    equal(parsed.tasks[0].provider, "fixture");
    equal(identityLabel(parsed.tasks[0]), `fixture/${FIXTURE_MODEL}`);

    const modelLines = [];
    equal(await cmdModels([], { cfg, env, registry, fetchImpl: async () => ({ ok: true }), write: (line) => modelLines.push(line) }), 0);
    ok(modelLines.some((line) => line.includes(FIXTURE_MODEL)), modelLines.join("\n"));

    const usageLines = [];
    equal(await cmdUsage([], {
      cfg, env, registry, fetchImpl: async () => ({ ok: true }), quotaCheck: async () => null,
      write: (line) => usageLines.push(line),
    }), 0);
    ok(usageLines.some((line) => line.includes("fixture weekly")), usageLines.join("\n"));

    const init = runCli(["grade", "--init", plan.resultsDir], { cwd: root, env });
    equal(init.status, 0, init.stderr);
    const gradesPath = join(plan.resultsDir, "grades.json");
    const grades = JSON.parse(readFileSync(gradesPath, "utf8"));
    grades.session = "provider-surface-test";
    for (const row of grades.rows) {
      row.domain = "node";
      row.outcome = "completed";
      row.grades = Object.fromEntries(Object.keys(row.grades).map((key) => [key, 8]));
    }
    writeFileSync(gradesPath, JSON.stringify(grades, null, 2) + "\n");
    const landed = runCli(["grade", "--file", gradesPath], { cwd: root, env });
    equal(landed.status, 0, landed.stderr);
    const scoreRows = readFileSync(join(home, "model-scores.jsonl"), "utf8")
      .trim().split("\n").map((line) => JSON.parse(line));
    ok(scoreRows.some((row) => row.provider === "fixture" && row.model === FIXTURE_MODEL));

    const perf = costView([
      { provider: "fixture", model: FIXTURE_MODEL, domain: "node", outcome: "completed", grades: { adherence: 8, handoff: 8, truthfulness: 8, depth: 8 } },
    ], [{ provider: "fixture", model: FIXTURE_MODEL, costDomain: "fixture:rate", mult: 1, requests: 1, measuredRequests: 1, weeks: 1, measuredWeeks: 1 }]);
    equal(perf.sections[0].provider, "fixture");

    const snapshot = buildSnapshot(home, new Map(), {
      _listRuns: () => [{ dir: join(home, "run"), project: "repo", name: "run", active: true, aborted: false, stopped: false, mtimeMs: 1 }],
      _readRun: () => ({ startedMs: 1, finishedMs: null, tasks: [{ provider: "fixture", model: FIXTURE_MODEL, tokens: { input: 3, output: 2 } }], waves: [], totals: { byState: { running: 1 } }, digestPath: null, reportPath: null }),
    });
    deepEqual(snapshot.rows[0].providers, ["fixture"]);
    equal(snapshot.rows[0].providerTokens.fixture, 5);

    const page = readFileSync(new URL("../src/serve/page.html", import.meta.url), "utf8");
    ok(page.includes("providerTokens") && page.includes("identityName"), "page consumes provider identity and token projections");

    const estate = { current: () => Promise.resolve(snapshot), refresh() {}, onSnapshot() {}, close() {} };
    const server = createServer({
      home,
      cfg: { ...cfg, grading: { enabled: true }, dashboard: { port: 0, bind: "127.0.0.1", token: null } },
      _estate: estate,
    });
    try {
      await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
      const runs = await getJson(server, "/api/runs");
      equal(runs.status, 200);
      deepEqual(runs.body.runs[0].providers, ["fixture"]);
      const serverPerf = await getJson(server, "/api/perf");
      equal(serverPerf.status, 200);
      equal(serverPerf.body.views.reliability[0].providers[0], "fixture");
    } finally {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    }
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("CLI roster hides disabled/denylisted cached providers and qualifies Claude collisions", async () => {
  const home = mkdtempSync(join(tmpdir(), "swarm-fourth-provider-roster-"));
  const root = join(home, "repo");
  mkdirSync(root, { recursive: true });
  const env = { ...process.env, SWARM_HOME: home };
  const registry = fixtureRegistry({ model: "haiku" });
  const cfg = config(root);
  try {
    const lines = [];
    await cmdModels([], { cfg, env, registry, fetchImpl: async () => ({ ok: true }), write: (line) => lines.push(line) });
    ok(lines.some((line) => line.startsWith("fixture/haiku")), lines.join("\n"));
    ok(lines.some((line) => line.startsWith("claude/haiku")), lines.join("\n"));

    const denylisted = [];
    await cmdModels([], { cfg: { ...cfg, modelDenylist: [FIXTURE_MODEL] }, env, registry, fetchImpl: async () => ({ ok: true }), write: (line) => denylisted.push(line) });
    ok(!denylisted.some((line) => line.includes(FIXTURE_MODEL)), denylisted.join("\n"));

    writeCompositeModelsCache([{ provider: "fixture", model: FIXTURE_MODEL }], env);
    const disabledCfg = { ...cfg, providers: { ...cfg.providers, fixture: { ...cfg.providers.fixture, enabled: false } } };
    const disabled = [];
    await cmdModels([], { cfg: disabledCfg, env, registry, fetchImpl: async () => ({ ok: true }), write: (line) => disabled.push(line) });
    ok(!disabled.some((line) => line.includes(FIXTURE_MODEL)), disabled.join("\n"));
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
