import "./helpers/isolate-home.mjs"; import { test } from "node:test";
import { equal, deepEqual } from "node:assert/strict";
import { rmSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { runPlan } from "../src/scheduler.mjs";
import { readResult } from "../src/results.mjs";
import { CFG, tmp, task, plan, fakeSpawnFactory, makeIo } from "./helpers/scheduler-fixtures.mjs";
import { CODEX_QUOTA_JSONL } from "./helpers/codex-quota.mjs";

test("quota: a Codex usage limit pre-fails pending Codex leaves, and one with a fallback hops to it", async () => {
  const dir = tmp();
  try {
    // The fallback leaf runs on Claude, so its wall is the Claude one: the same Codex
    // message on a Claude leaf is a plain failure, not a quota.
    const spawn = fakeSpawnFactory((call) => (call.args[call.args.indexOf("--model") + 1] === "claude-haiku-4-5-20251001"
      ? { exit: 1, output: "Claude AI usage limit reached — try again at 9:58 PM" }
      : { exit: 1, output: CODEX_QUOTA_JSONL }));
    const io = makeIo(spawn);
    const codexCfg = { ...CFG, providers: { codex: { enabled: true, path: "codex", allowedRoots: [dir] } } };
    const p = plan(dir, [
      task("first", { provider: "codex", model: "gpt-6-luna", cwd: dir }),
      task("second", { provider: "codex", model: "gpt-6-luna", cwd: dir }),
      task("saved", { provider: "codex", model: "gpt-6-luna", cwd: dir, fallbackProvider: "claude", fallbackModel: "claude-haiku-4-5-20251001" }),
    ], { concurrency: 1 });
    const r = await runPlan(p, codexCfg, io);
    const states = Object.fromEntries(r.summary.tasks.map((t) => [t.id, t.state]));
    equal(states.first, "quota");
    equal(states.second, "quota", "a pending Codex leaf must be pre-failed, never dispatched");
    equal(states.saved, "quota");
    // A pre-failed leaf writes no result, so the summary row is the only carrier of its
    // provider — what the CLI's quota line reads.
    equal(r.summary.tasks.find((t) => t.id === "second").provider, "codex");
    // first on Codex, saved on Codex, saved on its fallback — second never launched.
    equal(spawn.calls.length, 3);
    equal(spawn.calls[2].args[spawn.calls[2].args.indexOf("--model") + 1], "claude-haiku-4-5-20251001");
    const res = readResult(p.resultsDir, "first");
    equal(res.failureClass, "quota");
    equal(res.quotaResetsAt, "9:58 PM");
    // The fallback hit its own provider's wall in turn; that class survives on the result.
    equal(readResult(p.resultsDir, "saved").quotaResetsAt, "9:58 PM");
    const logLines = readFileSync(join(p.resultsDir, "run.log"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    const fb = logLines.find((l) => l.event === "fallback");
    deepEqual({ from: fb.fromProvider, to: fb.toProvider }, { from: "codex", to: "claude" });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
