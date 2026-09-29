// Transcript scan: everything swarm prints into a Claude session — the commands a
// session runs and the two hook injections — names no provider that is switched off.
// Operator, 2026-09-29: "it's just something I don't want e.g. transcripts spammed with
// their model designations", and it runs both ways: "if you have only codex enabled ...
// we should never see claude". Runtime output only; the static skill docs are out of scope.
//
// Each case seeds an isolated home with EVERY provider's roster, usage, scores, price
// card, history and a finished run, so a leak is a read that ignored the enabled flag,
// then drives the real entry points as child processes. Every fetch is recorded and
// answered 599: none leaves the machine, and none may go to a disabled provider's vendor.
// Score rows carry an explicit provider; a legacy row with none and a `gpt-*` model cannot be
// attributed, so it is kept (nothing infers codex from a model name). No line is exempted: the one allowed mention (the setting that enables a provider) is a
// config key, and none of these commands prints one.
import { test } from "node:test";
import { equal, ok } from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { runCli } from "./helpers/cli.mjs";

const RECORD = new URL("./helpers/record-fetch.mjs", import.meta.url).href;
const ULTRASWARM = fileURLToPath(new URL("../hooks/ultraswarm.mjs", import.meta.url));

// What each provider must never be called: its id, vendor and every seeded model name.
const PROVIDERS = {
  codex: { models: ["gpt-6-luna", "gpt-5.6-sol"], token: /codex|openai|gpt-/i },
  ollama: { models: ["deepseek-v4.1-flash:cloud", "glm-5.3:cloud"], token: /ollama|:cloud|deepseek|glm-5/i },
  claude: { models: ["claude-opus-5-5", "claude-sonnet-5"], token: /claude|anthropic|opus|sonnet|haiku|fable/i },
};
const IDS = Object.keys(PROVIDERS);
const NOW = Date.now();
const FUTURE = new Date(NOW + 3 * 86400e3).toISOString();

const write = (path, value) => {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, typeof value === "string" ? value : JSON.stringify(value), "utf8");
};

// A home in which every provider has left every trace the code knows how to read.
function seedHome(base, enabled) {
  const home = join(base, ".swarm");
  const config = {
    allowedRoots: [base],
    swarm: { always: true },
    quotaPreflight: false,
    providers: Object.fromEntries(IDS.map((id) => [id, { enabled: enabled.includes(id), allowedRoots: [base] }])),
  };
  config.providers.ollama.cloud = { ollama: { enabled: enabled.includes("ollama") } };
  write(join(home, "config.json"), config);

  const row = (provider, model) => ({ provider, model });
  write(join(home, "models-cache.json"), {
    providers: Object.fromEntries(IDS.filter((id) => id !== "claude").map((id) => [
      id, { hydratedAt: NOW, source: null, models: PROVIDERS[id].models.map((m) => row(id, m)) },
    ])),
  });
  write(join(base, ".claude", "cache", "model-catalog", "a-cc.json"), {
    fetchedAt: NOW, catalog: { config: { models: PROVIDERS.claude.models.map((id) => ({ id, name: id })) } },
  });

  write(join(home, "quota-cache.json"), { fetchedAt: NOW, result: { limits: [{ kind: "weekly", percent: 96, resetsAt: FUTURE }], exhausted: false } });
  write(join(home, "codex-usage.json"), {
    fetchedAt: NOW,
    result: { provider: "codex", buckets: [{ kind: "rate-limit", limitId: "codex", primary: { usedPercent: 96, windowDurationMins: 10080, resetsAt: FUTURE } }] },
  });
  write(join(home, "ollama-usage.json"), { fetchedAt: NOW, result: { weeklyPctUsed: 96, weeklyResetsAt: FUTURE, sessionPctUsed: 40 } });

  const score = (provider, model, i) => JSON.stringify({
    provider, ts: new Date(NOW - i * 3600e3).toISOString(), resultsDir: `/r/${provider}-${i}`, leaf: `leaf-${provider}-${i}`, model, effort: null,
    domain: "node", grades: { adherence: 8, handoff: 8, truthfulness: 8, depth: 8 }, outcome: "completed", note: "", assessedBy: { session: "t" },
  });
  write(join(home, "model-scores.jsonl"), IDS.flatMap((id) => PROVIDERS[id].models.flatMap((m, i) => [score(id, m, i), score(id, m, i + 2)])).join("\n") + "\n");

  // usage-history is Ollama's weekly meter, so only its models ever appear in it.
  write(join(home, "usage-history.jsonl"), JSON.stringify({
    fetchedAt: NOW, weeklyPctUsed: 50,
    weeklyModels: PROVIDERS.ollama.models.map((m) => ({ model: m.replace(/:cloud$/, ""), requests: 40, meterSharePct: 20 })),
  }) + "\n");

  write(join(home, "rate-cards.json"), {
    codex: { url: "https://developers.openai.com/api/docs/pricing.md", asOf: new Date(NOW).toISOString(), prices: { "gpt-6-luna": { input: 0.1, cachedInput: 0.01, output: 0.5 } } },
    claude: { url: "https://platform.claude.com/docs/en/about-claude/pricing.md", asOf: new Date(NOW).toISOString(), prices: { "claude-sonnet-5": { input: 2, cachedInput: 0.2, output: 10 } } },
  });

  for (const id of IDS) {
    const dir = join(home, "runs", "proj", `${id}-run`);
    write(join(dir, "manifest.json"), { resultsDir: dir, tasks: [{ id: "leaf", model: PROVIDERS[id].models[0], prompt: "x" }] });
    write(join(dir, "run.log"), JSON.stringify({ ts: new Date(NOW).toISOString(), event: "run-start", tasks: [{ id: "leaf", provider: id, model: PROVIDERS[id].models[0] }] }) + "\n");
    write(join(dir, "summary.json"), { results: [{ id: "leaf", state: "ok", model: PROVIDERS[id].models[0] }] });
  }
  return home;
}

function scan(enabled) {
  const base = mkdtempSync(join(tmpdir(), "swarm-transcript-"));
  spawnSync("git", ["init", "-q"], { cwd: base, windowsHide: true });
  const home = seedHome(base, enabled);
  const log = join(base, "fetches.log");
  writeFileSync(log, "");
  // A manifest that names only an enabled provider's model.
  const own = PROVIDERS[enabled[0]].models[0];
  write(join(base, "plan.json"), { tasks: [{ id: "only", provider: enabled[0], model: own, prompt: "Say hi." }] });
  // The refusal for a task with no provider lists what is registered.
  write(join(base, "bare.json"), { tasks: [{ id: "only", model: own, prompt: "Say hi." }] });
  const env = {
    SWARM_HOME: home, HOME: base, USERPROFILE: base, SWARM_FETCH_LOG: log,
    // A swarm leaf carries a correlation id, which silences the hooks: blank it, or the hook rows are vacuous.
    CORRELATION_ID: "",
    NODE_OPTIONS: `--import=${RECORD}`,
  };
  const outputs = {};
  try {
    for (const args of [["cost"], ["perf"], ["perf", "--overall"], ["models", "--all"], ["serve", "doctor"], ["usage"], ["quota"], ["list"], ["validate", join(base, "plan.json")], ["validate", join(base, "bare.json")]]) {
      const r = runCli(args, { cwd: base, env });
      outputs[`swarm ${args.map((a) => a.replaceAll("\\", "/").split("/").pop()).join(" ")}`] = `${r.stdout}${r.stderr}`;
    }
    for (const [event, extra] of [["SessionStart", {}], ["UserPromptSubmit", { prompt: "ultraswarm this" }]]) {
      const r = spawnSync(process.execPath, [ULTRASWARM], {
        input: JSON.stringify({ hook_event_name: event, cwd: base, ...extra }), encoding: "utf8", windowsHide: true,
        env: { ...process.env, ...env, SWARM_TEST_HOME: "1" },
      });
      outputs[`hook ${event}`] = `${r.stdout}${r.stderr}`;
    }
    return { outputs, urls: readFileSync(log, "utf8").split("\n").filter(Boolean) };
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
}

function leaks(outputs, provider) {
  const { token, models } = PROVIDERS[provider];
  const found = [];
  for (const [cmd, text] of Object.entries(outputs)) {
    for (const line of text.split("\n")) {
      if (token.test(line) || models.some((m) => line.includes(m))) found.push(`${cmd}: ${line.trim().slice(0, 160)}`);
    }
  }
  return found;
}

test("control: with every provider enabled the seeds ARE read — each provider shows up on some surface", () => {
  const { outputs } = scan(IDS);
  for (const id of IDS) ok(leaks(outputs, id).length > 0, `${id} seeded and enabled, but nothing printed names it — the scan below would be vacuous`);
  for (const key of ["hook SessionStart", "hook UserPromptSubmit", "swarm validate plan.json"]) {
    ok(outputs[key].trim().length > 0, `${key} printed nothing — a silent surface proves nothing`);
  }
});

const CASES = [
  { name: "codex disabled", enabled: ["claude", "ollama"] },
  { name: "ollama disabled", enabled: ["claude", "codex"] },
  { name: "claude disabled", enabled: ["codex", "ollama"] },
  { name: "only codex enabled", enabled: ["codex"] },
  { name: "only claude enabled", enabled: ["claude"] },
];

for (const { name, enabled } of CASES) {
  test(`transcript scan, ${name}: nothing printed names a disabled provider`, () => {
    const { outputs, urls } = scan(enabled);
    const found = IDS.filter((id) => !enabled.includes(id)).flatMap((id) => leaks(outputs, id).map((l) => `[${id}] ${l}`));
    equal(found.length, 0, `disabled providers named:\n${found.join("\n")}`);
    const vendors = { codex: /openai\.com/, claude: /anthropic\.com|claude\.com/, ollama: /ollama\.com|11434/ };
    for (const id of IDS.filter((x) => !enabled.includes(x))) {
      ok(!urls.some((u) => vendors[id].test(u)), `${id} is disabled but was requested: ${urls}`);
    }
  });
}
