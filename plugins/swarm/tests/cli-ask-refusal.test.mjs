import "./helpers/isolate-home.mjs";
import { test } from "node:test";
import { equal, ok } from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { writeFileSync, existsSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { runCliAsync, runValidated } from "./helpers/cli.mjs";
import { gateHome, tmp } from "./helpers/cli-fixture.mjs";

const SHIM = fileURLToPath(new URL("./shims/claude-shim.mjs", import.meta.url));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test("C2: run refuses to start while an ask is live", async () => {
  const dir = tmp();
  let askPromise;
  const releasePath = join(dir, "release");
  try {
    const home = gateHome(join(dir, "home"), { heartbeatSecs: 0.5 });
    const manifest = join(dir, "plan.json");
    writeFileSync(manifest, JSON.stringify({
      resultsDir: "out",
      tasks: [{ id: "t1", prompt: "x", provider: "claude", model: "claude-haiku-4-5-20251001" }],
    }));
    const resultsDir = join(dir, "out");

    const r0 = runValidated(["run", manifest], {
      cwd: dir,
      env: { SWARM_HOME: home, SWARM_SHIM_STREAM: "1", SWARM_SHIM_OUTPUT: "first answer" },
    });
    equal(r0.status, 0, r0.stdout + r0.stderr);
    const hbPath = join(resultsDir, "heartbeat");
    const baseline = statSync(hbPath).mtimeMs;

    askPromise = runCliAsync(["ask", resultsDir, "t1", "why?"], {
      cwd: dir,
      env: { SWARM_HOME: home, SWARM_SHIM_WAIT_FILE: releasePath, SWARM_SHIM_STREAM: "1", SWARM_SHIM_OUTPUT: "slow answer" },
    });

    const deadline = Date.now() + 10000;
    while (statSync(hbPath).mtimeMs === baseline && Date.now() < deadline) await sleep(20);
    ok(statSync(hbPath).mtimeMs > baseline, "the ask must touch the heartbeat before a concurrent run can be refused");

    const shimLog2 = join(dir, "shim2.log");
    const r1 = runValidated(["run", manifest], { cwd: dir, env: { SWARM_HOME: home, SWARM_SHIM_LOG: shimLog2 } });
    equal(r1.status, 1, r1.stdout + r1.stderr);
    ok(!existsSync(shimLog2), "run must refuse before dispatching anything while the ask is live");

    writeFileSync(releasePath, "");
    const a = await askPromise;
    equal(a.status, 0, a.stdout + a.stderr);
  } finally {
    writeFileSync(releasePath, "");
    await askPromise?.catch(() => {});
    rmSync(dir, { recursive: true, force: true });
  }
});

test("shim: SWARM_SHIM_WAIT_MS caps the wait when the release file never appears", () => {
  const dir = tmp();
  try {
    const r = spawnSync(process.execPath, [SHIM], {
      env: { ...process.env, SWARM_SHIM_WAIT_FILE: join(dir, "never-created"), SWARM_SHIM_WAIT_MS: "200", SWARM_SHIM_OUTPUT: "capped" },
      encoding: "utf8",
      timeout: 10000,
    });
    equal(r.status, 0, r.stderr);
    equal(r.stdout, "capped");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
