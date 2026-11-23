import "./helpers/isolate-home.mjs"; import { test } from "node:test";
import { equal, ok } from "node:assert/strict";
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { runValidated } from "./helpers/cli.mjs";
import { tmp } from "./helpers/cli-fixture.mjs";
import { CODEX_QUOTA_MESSAGE } from "./helpers/codex-quota.mjs";

// The quota line names the provider whose meter ran out — "Anthropic" was hard-coded
// and every Codex quota read as a Claude one.
test("run: a Codex quota leaf -> the summary line names codex", async () => {
  const dir = tmp();
  try {
    const manifest = join(dir, "plan.json");
    writeFileSync(manifest, JSON.stringify({
      resultsDir: "out",
      tasks: [{ id: "a", prompt: "x", provider: "codex", model: "gpt-6-luna" }],
    }));
    const env = {
      SWARM_HOME: join(dir, "home"),
      SWARM_SHIM_EXIT: "1",
      SWARM_CODEX_SHIM_FAIL: CODEX_QUOTA_MESSAGE,
    };
    const config = { providers: { codex: { enabled: true, allowedRoots: [dir] } } };
    const r = await runValidated(["run", manifest], { inProcess: true, cwd: dir, env, quotaPreflight: false, config });
    equal(r.status, 1, r.stdout + r.stderr);
    ok(r.stdout.includes("quota: 1 leaf(s) blocked by codex usage limits"), r.stdout);
    ok(r.stdout.includes("re-run after 9:58 PM"), r.stdout);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// Two meters run out in one run: each provider's leaves carry their own reset, so the
// line must not show the first reset it found beside both provider names.
test("run: a Codex and a Claude quota -> the line names each provider's own reset", async () => {
  const dir = tmp();
  try {
    const manifest = join(dir, "plan.json");
    writeFileSync(manifest, JSON.stringify({
      resultsDir: "out",
      concurrency: 1,
      tasks: [
        { id: "c", prompt: "x", provider: "claude", model: "claude-haiku-4-5-20251001" },
        { id: "x", prompt: "x", provider: "codex", model: "gpt-6-luna" },
      ],
    }));
    const env = {
      SWARM_HOME: join(dir, "home"),
      SWARM_SHIM_EXIT: "1",
      SWARM_SHIM_OUTPUT: "usage limit reached|1789200000",
      SWARM_CODEX_SHIM_EXIT: "1",
      SWARM_CODEX_SHIM_FAIL: CODEX_QUOTA_MESSAGE,
      TZ: "Europe/London",
    };
    const config = {
      providers: {
        claude: { enabled: true, allowedRoots: [dir] },
        codex: { enabled: true, allowedRoots: [dir] },
      },
    };
    const r = await runValidated(["run", manifest], { inProcess: true, cwd: dir, env, quotaPreflight: false, config });
    equal(r.status, 1, r.stdout + r.stderr);
    const line = r.stdout.split("\n").find((l) => l.includes("quota: "));
    ok(line, r.stdout);
    ok(line.includes("blocked by claude, codex usage limits"), line);
    ok(line.includes("Sat 12 Sep, 09:00 (claude)"), line);
    ok(line.includes("9:58 PM (codex)"), line);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
