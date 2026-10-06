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

// A crash is the one exit that never reaches `releaseEngine`, so the claim it leaves
// is the only one the operator has to get past. The lock alone must not refuse: its
// owner is dead, which is what `engineAlive` is asked. This is the end-to-end half of
// the unit row — it proves `cmdRun` reaches the claim and proceeds, not just that the
// claim function would have said yes.
test("resume: a crashed engine's claim is cleared by the next run, with no manual step", async () => {
  const dir = tmp();
  try {
    const home = join(dir, "home");
    const manifest = join(dir, "plan.json");
    writeFileSync(manifest, JSON.stringify({
      resultsDir: "out",
      tasks: [{ id: "t1", prompt: "x", provider: "claude", model: "claude-haiku-4-5-20251001" }],
    }));
    const env = { SWARM_HOME: home, SWARM_SHIM_STREAM: "1", SWARM_SHIM_OUTPUT: "x" };
    const v = runCli(["validate", manifest], { cwd: dir, env });
    equal(v.status, 0, v.stderr);
    const r1 = runCli(["run", manifest], { cwd: dir, env });
    equal(r1.status, 0, r1.stdout + r1.stderr);

    const out = join(dir, "out");
    // Exactly what a crash leaves: the claim on disk, its owner gone, and no heartbeat
    // ticking. Written by hand because killing a process mid-run would race the cleanup
    // the crash is meant to skip.
    writeFileSync(join(out, "engine.lock"), `${new Date().toISOString()} 999999\n`);
    rmSync(join(out, "heartbeat"), { force: true });

    const r2 = runCli(["run", manifest], { cwd: dir, env });
    equal(r2.status, 0, `a dead owner's claim must not refuse the resume: ${r2.stdout}${r2.stderr}`);
    ok(!/already has a live engine/.test(r2.stderr), r2.stderr);
    equal(existsSync(join(out, "engine.lock")), false, "the takeover must release on exit too");
    equal(runStarts(out).length, 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// `ask` drives the same resultsDir a run does, so it takes the same claim. The
// lock must be on disk for as long as the engine is, which is why this test waits
// for the file rather than assuming the order the two processes reach it in.
test("ask: refused while an engine holds the claim, and its own claim is released on exit", async () => {
  const dir = tmp();
  try {
    const home = join(dir, "home");
    const manifest = join(dir, "plan.json");
    writeFileSync(manifest, JSON.stringify({
      resultsDir: "out",
      tasks: [{ id: "t1", prompt: "x", provider: "claude", model: "claude-haiku-4-5-20251001" }],
    }));
    const env = { SWARM_HOME: home, SWARM_SHIM_STREAM: "1", SWARM_SHIM_OUTPUT: "because X" };
    const v = runCli(["validate", manifest], { cwd: dir, env });
    equal(v.status, 0, v.stderr);
    // An ask resumes a finished leaf, so one real run has to land first.
    const r0 = runCli(["run", manifest], { cwd: dir, env });
    equal(r0.status, 0, r0.stdout + r0.stderr);
    const out = join(dir, "out");
    equal(existsSync(join(out, "engine.lock")), false, "a finished engine must release its claim");

    // A second engine held open by a slow leaf: its claim is on disk for the whole run.
    const slow = runCliAsync(["run", manifest, "--force"], { cwd: dir, env: { ...env, SWARM_SHIM_SLEEP_MS: "8000" } });
    const deadline = Date.now() + 60_000;
    while (!existsSync(join(out, "engine.lock")) && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 25));
    }
    ok(existsSync(join(out, "engine.lock")), "a running engine must hold its claim");
    const owner = Number(readFileSync(join(out, "engine.lock"), "utf8").trim().split(" ")[1]);

    const refused = runCli(["ask", out, "t1", "why?"], { cwd: dir, env });
    equal(refused.status, 1, refused.stdout + refused.stderr);
    ok(/already has a live engine/.test(refused.stderr), refused.stderr);
    ok(refused.stderr.includes(`pid ${owner}`), `refusal must name the owner pid ${owner}: ${refused.stderr}`);

    const r1 = await slow;
    equal(r1.status, 0, r1.stdout + r1.stderr);
    equal(existsSync(join(out, "engine.lock")), false, "a finished engine releases its claim");

    const asked = runCli(["ask", out, "t1", "why?"], { cwd: dir, env });
    equal(asked.status, 0, asked.stdout + asked.stderr);
    equal(existsSync(join(out, "engine.lock")), false, "an ask releases its own claim on exit");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// The test above is refused by the heartbeat pre-check in `main`, which master already
// has — so it passes with `askLeaf`'s claim deleted. This one cannot: the lock says live
// and there is no heartbeat at all, which is exactly the pre-heartbeat startup window a
// second engine used to slip into. Only the claim itself refuses this ask.
test("ask: a live claim refuses an ask that has no heartbeat to read", async () => {
  const dir = tmp();
  try {
    const home = join(dir, "home");
    const manifest = join(dir, "plan.json");
    writeFileSync(manifest, JSON.stringify({
      resultsDir: "out",
      tasks: [{ id: "t1", prompt: "x", provider: "claude", model: "claude-haiku-4-5-20251001" }],
    }));
    const env = { SWARM_HOME: home, SWARM_SHIM_STREAM: "1", SWARM_SHIM_OUTPUT: "x" };
    const v = runCli(["validate", manifest], { cwd: dir, env });
    equal(v.status, 0, v.stderr);
    const r0 = runCli(["run", manifest], { cwd: dir, env });
    equal(r0.status, 0, r0.stdout + r0.stderr);

    const out = join(dir, "out");
    // This process's own pid, so it reads alive; no heartbeat, so the pre-check's
    // liveness read (which bails on a missing heartbeat) cannot be what refuses.
    rmSync(join(out, "heartbeat"), { force: true });
    writeFileSync(join(out, "engine.lock"), `${new Date().toISOString()} ${process.pid}\n`);

    const refused = runCli(["ask", out, "t1", "why?"], { cwd: dir, env });
    equal(refused.status, 1, refused.stdout + refused.stderr);
    ok(/already has a live engine/.test(refused.stderr), refused.stderr);
    ok(refused.stderr.includes(`pid ${process.pid}`), `the refusal must name the claim's owner: ${refused.stderr}`);
    equal(readFileSync(join(out, "engine.lock"), "utf8").trim().split(" ")[1], String(process.pid),
      "a refused ask must leave the owner's claim alone");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// `stop` is the operator's way out of a long run. It exits through the scheduler's
// finally like any other end, so the claim must go with it — a claim that outlives
// its engine refuses the resume the operator runs next.
test("stop: a live engine holds its claim, and `swarm stop` releases it", async () => {
  const dir = tmp();
  let run;
  try {
    const home = join(dir, "home");
    const manifest = join(dir, "plan.json");
    writeFileSync(manifest, JSON.stringify({
      resultsDir: "out",
      tasks: [{ id: "t1", prompt: "x", provider: "claude", model: "claude-haiku-4-5-20251001" }],
    }));
    const env = { SWARM_HOME: home, SWARM_SHIM_STREAM: "1", SWARM_SHIM_OUTPUT: "x", SWARM_SHIM_SLEEP_MS: "30000" };
    const v = runCli(["validate", manifest], { cwd: dir, env });
    equal(v.status, 0, v.stderr);
    run = runCliAsync(["run", manifest], { cwd: dir, env });
    const out = join(dir, "out");
    const deadline = Date.now() + 60_000;
    while (!existsSync(join(out, "heartbeat")) && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 25));
    }
    ok(existsSync(join(out, "heartbeat")), "engine must have started ticking before stop is issued");
    // The claim is taken before the heartbeat, so a ticking engine always holds one.
    ok(existsSync(join(out, "engine.lock")), "a live engine must hold its claim");

    const stopped = runCli(["stop", out], { cwd: dir, env });
    equal(stopped.status, 0, stopped.stdout + stopped.stderr);
    const r = await run;
    run = null;
    equal(r.status, 1, r.stdout + r.stderr);
    equal(existsSync(join(out, "engine.lock")), false, "a stopped engine must release its claim");
  } finally {
    // An assertion above throws while the engine is still running — which is exactly
    // what happens when the claim regresses, the case this test exists to catch. The
    // live child holds its temp dir open, so an unwaited rmSync fails EPERM and, being
    // a throw from `finally`, replaces the assertion that would have explained it.
    if (run) await run;
    rmSync(dir, { recursive: true, force: true });
  }
});
