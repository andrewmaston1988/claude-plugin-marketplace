import { test } from "node:test";
import { equal, ok } from "node:assert/strict";
import { mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { runCli, runCliAsync } from "./helpers/cli.mjs";
import { tmp } from "./helpers/cli-fixture.mjs";

// The startup window `swarm-engine-start-lock` closes: `cmdRun` resolves a
// resultsDir, checks liveness, and only then walks the estimate's corpus and
// runs `runPlan`'s startup — the heartbeat starts last of all. A second
// `swarm run` of the same manifest started inside that window sees no heartbeat,
// passes the same check, and two engines drive one resultsDir.
//
// The corpus the estimate walks sits INSIDE that window (`scripts/swarm.mjs`
// loadCorpus, after the liveness check), so a fat corpus holds the window open
// long enough for a second process to land in it. 4000 runs measured 5/5.
function fatCorpus(home, n) {
  const runsRoot = join(home, "runs", "bulk");
  for (let i = 0; i < n; i++) {
    const d = join(runsRoot, `run-${i}`);
    mkdirSync(d, { recursive: true });
    writeFileSync(join(d, "summary.json"), JSON.stringify({
      tasks: [{ id: "a", state: "ok", provider: "claude", model: "claude-haiku-4-5-20251001", tokens: { input: 10, output: 10, cacheRead: 0, cacheWrite: 0 } }],
    }));
  }
}

const runStarts = (resultsDir) =>
  readFileSync(join(resultsDir, "run.log"), "utf8").trim().split("\n")
    .map((l) => JSON.parse(l)).filter((l) => l.event === "run-start");

test("race: two `swarm run` processes on one manifest — exactly one engine starts", async () => {
  const dir = tmp();
  try {
    const home = join(dir, "home");
    fatCorpus(home, 4000);
    const manifest = join(dir, "plan.json");
    writeFileSync(manifest, JSON.stringify({
      resultsDir: "out",
      tasks: [{ id: "a", prompt: "x", provider: "claude", model: "claude-haiku-4-5-20251001" }],
    }));
    const env = { SWARM_HOME: home, SWARM_SHIM_OUTPUT: "leaf-out", SWARM_SHIM_SLEEP_MS: "1500" };
    // Validated up front, not per racer: `validate` walks the same corpus, so two
    // sequential runValidated calls would stagger the spawns by the whole walk
    // and let the first engine's heartbeat land before the second even started.
    const v = runCli(["validate", manifest], { cwd: dir, env });
    equal(v.status, 0, v.stderr);

    const [a, b] = await Promise.all([
      runCliAsync(["run", manifest], { cwd: dir, env }),
      runCliAsync(["run", manifest], { cwd: dir, env }),
    ]);

    const starts = runStarts(join(dir, "out"));
    equal(starts.length, 1, `two engines both recorded run-start: ${starts.length}`);
    const refused = [a, b].filter((r) => r.status === 1);
    equal(refused.length, 1, `exactly one engine must be refused; statuses ${a.status}/${b.status}\n${a.stderr}\n${b.stderr}`);
    ok(/already has a live engine/.test(refused[0].stderr), refused[0].stderr);
    ok(new RegExp(`pid ${starts[0].pid}\\b`).test(refused[0].stderr), `refusal must name the owner pid ${starts[0].pid}: ${refused[0].stderr}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("ownership: a finished run leaves no claim behind — the next run starts", async () => {
  const dir = tmp();
  try {
    const home = join(dir, "home");
    const manifest = join(dir, "plan.json");
    writeFileSync(manifest, JSON.stringify({
      resultsDir: "out",
      tasks: [{ id: "a", prompt: "x", provider: "claude", model: "claude-haiku-4-5-20251001" }],
    }));
    const env = { SWARM_HOME: home, SWARM_SHIM_OUTPUT: "leaf-out" };
    const r1 = runCli(["validate", manifest], { cwd: dir, env });
    equal(r1.status, 0, r1.stderr);
    const r2 = runCli(["run", manifest], { cwd: dir, env });
    equal(r2.status, 0, r2.stdout + r2.stderr);
    equal(existsSync(join(dir, "out", "engine.lock")), false, "a finished engine must release its claim");

    const r3 = runCli(["run", manifest, "--force"], { cwd: dir, env });
    equal(r3.status, 0, r3.stdout + r3.stderr);
    equal(runStarts(join(dir, "out")).length, 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
