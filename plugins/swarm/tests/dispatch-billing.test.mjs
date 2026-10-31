// A billed leaf's dispatch: the inline --settings clear that keeps an inherited
// routing variable from outranking the API key. Split from dispatch.test.mjs,
// which is over the 500-line bar and may not grow.
import { test } from "node:test";
import { equal, ok, throws } from "node:assert/strict";
import { buildDispatch } from "../src/dispatch.mjs";

const CFG = {
  provider: {
    mode: "env",
    url: "http://localhost:11434",
    authToken: "ollama",
    launchCmd: "ollama launch claude --model {model} -- {args}",
  },
};

const task = (over = {}) => ({
  id: "t", provider: "claude", model: "claude-haiku-4-5-20251001", effort: "medium", allowedTools: "Read,Grep,Glob", ...over,
});

// ── billing: "api" — the inline routing clear ─────────────────────────────────
// Every name below ranks above an API key in Claude Code's credential chain;
// this machine's parent shell exports the first two for the Ollama wrapper.
// "" inside --settings acts as unset, and --settings is the only layer above
// both the shell and settings.json.
const ROUTING_ENV = [
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_BASE_URL",
  "CLAUDE_CODE_USE_BEDROCK",
  "CLAUDE_CODE_USE_VERTEX",
  "CLAUDE_CODE_USE_FOUNDRY",
];
const settingsOf = (d) => JSON.parse(d.argv[d.argv.indexOf("--settings") + 1]);

test("billing api: the inline --settings clears all five routing variables", () => {
  const d = buildDispatch(task({ billing: "api", settings: { env: { OTHER: "x" } } }), "p", CFG);
  equal(d.env.ANTHROPIC_API_KEY, undefined, "the key never rides the dispatch env");
  const settings = settingsOf(d);
  for (const key of ROUTING_ENV) equal(settings.env[key], "", key);
  equal(settings.env.OTHER, "x", "an unrelated task setting survives");
  equal(d.argv.filter((a) => a === "--settings").length, 1);
});

// settings is null for a task with no authored settings on the default
// disable1mContext; a billed leaf must still materialise it or it inherits the
// parent's ANTHROPIC_AUTH_TOKEN and bills the subscription under a claude-api label.
test("billing api: a task with no settings still emits --settings carrying the five keys", () => {
  const d = buildDispatch(task({ billing: "api" }), "p", { ...CFG, disable1mContext: true });
  ok(d.argv.includes("--settings"), d.argv.join(" "));
  const settings = settingsOf(d);
  for (const key of ROUTING_ENV) equal(settings.env[key], "", key);
});

// Composition reached directly, past the manifest guard: the routing values are
// applied last, so an authored value can never outrank the clear.
test("billing api: the routing keys beat a task-authored value", () => {
  const authored = { env: { ANTHROPIC_AUTH_TOKEN: "task-token", ANTHROPIC_BASE_URL: "http://task.invalid", OTHER: "y" } };
  const d = buildDispatch(task({ billing: "api", settings: authored }), "p", CFG);
  const settings = settingsOf(d);
  equal(settings.env.ANTHROPIC_AUTH_TOKEN, "");
  equal(settings.env.ANTHROPIC_BASE_URL, "");
  equal(settings.env.OTHER, "y");
});

test("billing api: the key appears in no argv element", () => {
  const real = process.env.SWARM_ANTHROPIC_API_KEY;
  const probe = "sk-ant-argv-scan-9f3a";
  process.env.SWARM_ANTHROPIC_API_KEY = probe;
  try {
    const d = buildDispatch(task({ billing: "api" }), "p", CFG);
    ok(!d.argv.some((a) => String(a).includes(probe)), `the key leaked into argv: ${d.argv.join(" ")}`);
  } finally {
    if (real === undefined) delete process.env.SWARM_ANTHROPIC_API_KEY;
    else process.env.SWARM_ANTHROPIC_API_KEY = real;
  }
});

// RED (revert): apply applyBillingRouting unconditionally and every subscription
// leaf silently loses the routing context it inherits from the shell.
test("no billing: a Claude leaf carries no routing keys, and no --settings when it authored none", () => {
  const plain = buildDispatch(task(), "p", CFG);
  ok(!plain.argv.includes("--settings"));
  const settings = settingsOf(buildDispatch(task({ settings: { env: { OTHER: "x" } } }), "p", CFG));
  for (const key of ROUTING_ENV) equal(settings.env[key], undefined, key);
  equal(settings.env.OTHER, "x");
});

test("billing api on a non-Claude provider is refused", () => {
  throws(
    () => buildDispatch(task({ provider: "ollama", model: "minimax-m3:cloud", billing: "api" }), "p", CFG),
    /billing "api".*claude/i,
  );
});

// RED (revert): read the key inside buildClaudeInvocation and the validation-time
// callers (manifest preview, dispatch budget) throw before a run ever starts.
test("billing api: composition needs no key in the environment", () => {
  const real = process.env.SWARM_ANTHROPIC_API_KEY;
  delete process.env.SWARM_ANTHROPIC_API_KEY;
  try {
    const d = buildDispatch(task({ billing: "api" }), "p", CFG);
    equal(d.argv[0], "claude");
    ok(d.argv.includes("--settings"));
  } finally {
    if (real !== undefined) process.env.SWARM_ANTHROPIC_API_KEY = real;
  }
});
