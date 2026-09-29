// `swarm ask` prints the work tokens of the follow-up, with cache read as a labelled
// breakdown only when there was some (swarm-token-headline-work, 2026-09-29).
import { test } from "node:test";
import { equal, ok } from "node:assert/strict";
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { runCli, runValidated } from "./helpers/cli.mjs";
import { tmp } from "./helpers/cli-fixture.mjs";

function askLine(cacheRead) {
  const dir = tmp();
  try {
    const manifest = join(dir, "plan.json");
    writeFileSync(manifest, JSON.stringify({ resultsDir: "out", tasks: [{ id: "t1", prompt: "x", provider: "claude", model: "claude-haiku-4-5-20251001" }] }));
    const env = { SWARM_HOME: join(dir, "home"), SWARM_SHIM_STREAM: "1", SWARM_SHIM_OUTPUT: "because X", ...(cacheRead && { SWARM_SHIM_CACHE_READ: String(cacheRead) }) };
    const r0 = runValidated(["run", manifest], { cwd: dir, env });
    equal(r0.status, 0, r0.stdout + r0.stderr);
    const a = runCli(["ask", join(dir, "out"), "t1", "why?"], { cwd: dir, env });
    equal(a.status, 0, a.stdout + a.stderr);
    return a.stdout.split("\n").find((l) => l.includes("tokens:"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("ask: a cache-heavy follow-up headlines its work and names the cache read beside it", () => {
  const line = askLine(2_000_000);
  ok(line.includes("tokens: 1.5k · cache read 2M · session "), line);
  ok(!line.includes("2M tokens") && !line.includes("2.00M"), line);
});

test("ask: no cache read, no cache read text", () => {
  const line = askLine(0);
  ok(line.includes("tokens: 1.5k · session "), line);
  ok(!line.includes("cache read"), line);
});
