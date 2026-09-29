import { test } from "node:test";
import { equal, ok, match, rejects } from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { decide, modeFor, standingBlock, KEYWORD_LINE, MODE_ARMED, MODE_UNARMED } from "../hooks/ultraswarm.mjs";
import { normalizeOllama, normalizeAnthropic } from "../src/usage.mjs";

const E = ["claude", "ollama"];
const armed = { swarm: { always: true }, provider: { allowedRoots: ["C:/code"] } };

test("decide: SessionStart arms only on swarm.always; UserPromptSubmit only on the keyword", async () => {
  equal(await decide({ enabled: E, event: "SessionStart", cwd: "C:/code/x", config: armed }), standingBlock(MODE_ARMED, E));
  equal(await decide({ enabled: E, event: "SessionStart", cwd: "C:/code/x", config: { provider: armed.provider } }), null);
  // the keyword path names its trigger, outside the locked block; SessionStart (above) does not
  equal(await decide({ enabled: E, event: "UserPromptSubmit", prompt: "please ULTRASWARM this", cwd: "C:/code/x", config: {} }), `${KEYWORD_LINE}
${standingBlock(MODE_UNARMED, E)}`);
  match(KEYWORD_LINE ?? "", /`ultraswarm`/);
  equal(await decide({ enabled: E, event: "UserPromptSubmit", prompt: "ordinary prompt", cwd: "C:/code/x", config: armed }), null);
  // the keyword is a standalone word — a filename or path token never arms it
  for (const p of ["edit hooks/ultraswarm.mjs", "tests/ultraswarm.test.mjs failed", "see ultraswarm-notes"]) {
    equal(await decide({ enabled: E, event: "UserPromptSubmit", prompt: p, cwd: "C:/code/x", config: {} }), null, p);
  }
  equal(await decide({ enabled: E, event: "PreToolUse", prompt: "ultraswarm", cwd: "C:/code/x", config: armed }), null);
});

test("modeFor: cloud under an allowed root (either slash style, any case), Anthropic otherwise", async () => {
  const cfg = { provider: { allowedRoots: ["C:/code"] } };
  equal(await modeFor({ cwd: "C:/code/claude-plugin-marketplace", config: cfg }), MODE_ARMED);
  // Windows paths are case-insensitive and either slash; POSIX paths are case-sensitive,
  // and a governance gate must never widen them.
  equal(await modeFor({ cwd: "c:\\CODE\\primordial", config: cfg }), process.platform === "win32" ? MODE_ARMED : MODE_UNARMED);
  equal(await modeFor({ cwd: "C:/code", config: cfg }), MODE_ARMED);
  equal(await modeFor({ cwd: "C:/codex/other", config: cfg }), MODE_UNARMED);
  equal(await modeFor({ cwd: "D:/work", config: cfg }), MODE_UNARMED);
  equal(await modeFor({ cwd: "C:/code/x", config: { provider: { allowedRoots: [] } } }), MODE_UNARMED);
  equal(await modeFor({ cwd: "C:/code/x", config: null }), MODE_UNARMED);
});

// The operator-locked wording (2026-09-26), transcribed here as literals rather than
// referenced through an exported constant: a shared constant would move with the hook and
// the pin would never bite. Any edit to the block — a reflowed line, a dropped table row —
// fails this row, which is the point of "LOCKED".
const LOCKED_BLOCK = (mode, tier) => `<EXTREMELY_IMPORTANT>
You have swarm. The operator has decided in advance: swarm is PRE-AUTHORISED.
It spreads cost across providers, optimises spend, offloads and compresses carried
context, and applies committee judgement. The trade-off is settled — not yours to weigh.

<EXTREMELY-IMPORTANT>
If there is even a 1% chance work can be delegated, fanned out, or judged by
another model, you ABSOLUTELY MUST swarm it.
This is not negotiable. You cannot rationalise your way out of it.
</EXTREMELY-IMPORTANT>

## The Rule
**Before any delegable work**: invoke Skill(swarm:swarm), read orchestrating-agents
and executing-swarms, print the derivation (partition §2, block §2a, graph §3), then models ->
author -> validate -> dispatch. Ask none of the settled calls: presenting one back for
approval is the defect.
Solo ONLY for a conversational reply, a single one-read question, or a trivial edit.

## Red Flags
| Thought | Reality |
|---|---|
| "Inline is quicker" | The operator decided in advance. Period. |
| "It's too small to swarm" | Size is not the test. The decision is already made. |
| "A leaf will do it worse" | You verify every leaf; committee judgement beats one pass. |
| "I'll check with the operator first" | They answered in advance. Asking back is the defect. |
| "I know the command, I can skip the skill" | The command arrives without the rules that govern it. |
| "An Agent/Workflow will do" | Swarm is the fan-out tier (${tier}); Agent only for one run that ${/claude/.test(tier) ? "must be on Anthropic" : "must stay on this host"}. |
| "I'll peek at the leaf's log" | One status check, then hands-off until the notification. |

Mode: ${mode}
</EXTREMELY_IMPORTANT>`;

test("standingBlock is the locked wording, verbatim, for either mode", () => {
  for (const mode of [MODE_ARMED, MODE_UNARMED]) {
    const block = standingBlock(mode, E);
    equal(block, LOCKED_BLOCK(mode, "claude, ollama"));
    match(block, /^<EXTREMELY_IMPORTANT>\n[\s\S]*\n<\/EXTREMELY_IMPORTANT>$/);
    equal((block.match(/\[[^\]]+\]/g) || []).length, 1, "exactly one mode bracket");
    ok(!/AskUserQuestion/.test(block), "no question");
  }
});

// Operator, 2026-09-29: "It should list what is enabled, or setup pending." The one row
// that names providers lists the enabled ones and nothing else.
test("the Agent row lists the enabled providers, never a disabled one", async () => {
  const row = (block) => block.split("\n").find((l) => l.startsWith('| "An Agent/Workflow will do"'));
  equal(row(standingBlock(MODE_ARMED, ["codex"])), '| "An Agent/Workflow will do" | Swarm is the fan-out tier (codex); Agent only for one run that must stay on this host. |');
  ok(!/claude|anthropic/i.test(standingBlock(MODE_ARMED, ["codex"])), "only codex enabled names no claude");
  equal(row(standingBlock(MODE_ARMED, [])), '| "An Agent/Workflow will do" | Swarm is the fan-out tier (setup pending); Agent only for one run that must stay on this host. |');
  const setup = await decide({ enabled: ["codex"], event: "SessionStart", cwd: "C:/code/x", config: null });
  ok(row(setup).includes("(setup pending)"), row(setup));
  // The operator-locked Anthropic criterion stands whenever Claude is enabled.
  equal(row(standingBlock(MODE_ARMED, ["claude", "codex"])), '| "An Agent/Workflow will do" | Swarm is the fan-out tier (claude, codex); Agent only for one run that must be on Anthropic. |');
});

test("decide requires the enabled provider list on an armed event", async () => {
  await rejects(decide({ event: "SessionStart", cwd: "C:/code/x", config: armed }), TypeError);
});

// R8b — a fresh install gets nothing at SessionStart today, so the session learns the
// plugin is installed but unrouted only by failing at it. The setup sentence rides INSIDE
// the block, and every other locked line stays: the operator's call was "it shouldnt swap
// anything; it should show the message when swarm is not yet configured".
const SETUP_LINE = "You have the swarm plugin but it is not configured, the operator has installed it and expects it to work. The first thing that you must do is run /swarm:swarm setup";

test("decide: R8b — an unconfigured install is told to run setup, inside the block", async () => {
  for (const [label, config] of [["no config file", null], ["no allowedRoots", { providers: { ollama: { enabled: true } } }]]) {
    // swarm.always is NOT set in either: the setup message is not gated on standing mode.
    const out = await decide({ enabled: E, event: "SessionStart", cwd: "C:/code/x", config });
    ok(out, `${label}: an unconfigured install must hear something at SessionStart`);
    const open = out.indexOf("<EXTREMELY_IMPORTANT>");
    const close = out.indexOf("</EXTREMELY_IMPORTANT>");
    ok(open === 0 && close > open, `${label}: the setup sentence must sit inside the block: ${out}`);
    ok(out.slice(open, close).includes("/swarm:swarm setup"), `${label}: no setup route in the block: ${out}`);
    ok(out.split("\n")[1] === SETUP_LINE, `${label}: the block opens on the setup sentence: ${out.split("\n")[1]}`);
    ok(!out.includes("You have swarm. The operator has decided in advance"), `${label}: no standing claim on an unconfigured install`);
    // Everything below the identity line is still the locked block, unchanged.
    for (const line of LOCKED_BLOCK(MODE_UNARMED, "setup pending").split("\n").slice(2)) {
      ok(out.includes(line), `${label}: the block lost a line: ${line}`);
    }
  }
});

test("decide: R8b — a configured install's block carries no setup sentence", async () => {
  const out = await decide({ enabled: E, event: "SessionStart", cwd: "C:/code/x", config: armed });
  equal(out, standingBlock(MODE_ARMED, E));
  ok(!out.includes("/swarm:swarm setup"), out);
});

test("the hook never probes and reads no models cache — the block carries no model list", () => {
  const src = readFileSync(fileURLToPath(new URL("../hooks/ultraswarm.mjs", import.meta.url)), "utf8");
  ok(!src.includes("probeTopModels") && !src.includes("/api/generate"));
  ok(!src.includes("models-cache"), "no models-cache read");
});

const ALWAYS = { swarm: { always: true }, provider: { allowedRoots: ["C:/code"] } };
const dec = (reading) => decide({ enabled: E,
  event: "SessionStart", cwd: "C:/code/x", config: ALWAYS,
  usage: reading ? [normalizeOllama(reading)] : [],
});
const OLLAMA = { sessionPctUsed: 10, sessionResetsAt: "S", weeklyPctUsed: 50, resetsAt: "W" };

test("decide: U1 RED — an exhausted provider names the reset, OUTSIDE the standing block", async () => {
  const prevTz = process.env.TZ;
  process.env.TZ = "Europe/London";
  let out;
  try {
    out = await dec({ ...OLLAMA, state: "exhausted", weeklyPctUsed: 100, resetsAt: "2026-09-07T00:00:00Z" });
  } finally {
    if (prevTz === undefined) delete process.env.TZ; else process.env.TZ = prevTz;
  }
  ok(out.includes("Mon 7 Sep, 01:00"), out);
  // The block is instruction and ends where it ends; the usage line follows it.
  ok(out.startsWith(standingBlock(MODE_ARMED, E) + "\n"), out);
  ok(out.endsWith("</EXTREMELY_IMPORTANT>") === false, out);
});

test("decide: U2 false-positive guard — a healthy provider emits the block and NOTHING else", async () => {
  equal(await dec({ ...OLLAMA, state: "ok" }), standingBlock(MODE_ARMED, E));
});

test("modeFor: U3 governance decides the mode; the meter never touches it", async () => {
  equal(await modeFor({ cwd: "C:/codex/other", config: { provider: { allowedRoots: ["C:/code"] } } }), MODE_UNARMED);
  equal(await modeFor({ cwd: "C:/code/x", config: { provider: { allowedRoots: [] } } }), MODE_UNARMED);
  // An exhausted meter is availability, not preference — the bracket is unmoved.
  ok((await dec({ ...OLLAMA, state: "exhausted", weeklyPctUsed: 100 })).includes(`Mode: ${MODE_ARMED}`));
});

// U4 — provenance replaces the age classification: a reading that was NOT
// fetched this process says so, with the banner text and its fix; a LIVE one
// says nothing.
test("decide: U4 a cached provider carries its banner, the standing block unchanged; a live one is silent", async () => {
  const cached = await dec({
    ...OLLAMA, provenance: "cached", reason: "expired-cookie",
    lastSeen: Date.parse("2026-09-08T14:49:00Z"), cookiePath: "cp",
  });
  ok(cached.includes("/!\\ Cookie Expired"), cached);
  ok(cached.includes(`last seen: ${new Date(Date.parse("2026-09-08T14:49:00Z")).toISOString()}`), "absolute UTC last-seen, not an age");
  ok(cached.startsWith(standingBlock(MODE_ARMED, E) + "\n"), cached);

  const live = await dec({ ...OLLAMA, provenance: "live" });
  ok(!live.includes("/!\\"), `a live reading prints no banner: ${live}`);
  equal(live, standingBlock(MODE_ARMED, E), "no banner means no extra lines at all");
});

test("decide: U6 every notable provider gets its own lines", async () => {
  const out = await decide({ enabled: E,
    event: "SessionStart", cwd: "C:/code/x", config: ALWAYS,
    usage: [
      normalizeAnthropic({ limits: [{ kind: "weekly", percent: 100, resetsAt: "A" }], exhausted: true }),
      normalizeOllama({ ...OLLAMA, provenance: "cached", reason: "expired-cookie" }),
    ],
  });
  ok(/anthropic: weekly allowance exhausted/.test(out), out);
  ok(out.includes("/!\\ Cookie Expired"), "the ollama banner rides on its own lines");
});

test("modeFor/decide: U5 always-green guard — a missing headroom argument does not break the hook", async () => {
  const cfg = { provider: { allowedRoots: ["C:/code"] } };
  equal(await modeFor({ cwd: "C:/code/x", config: cfg }), MODE_ARMED);
  equal(await decide({ enabled: E, event: "SessionStart", cwd: "C:/code/x", config: { swarm: { always: true }, provider: cfg.provider } }), standingBlock(MODE_ARMED, E));
});

// Claude is gated by allowedRoots like every provider, so its roots alone arm the mode —
// and a disabled Claude's do not.
test("modeFor: roots on Claude alone arm the mode; a disabled Claude's do not", async () => {
  const cfg = { providers: { claude: { enabled: true, allowedRoots: ["C:/code"] }, ollama: { enabled: true } } };
  equal(await modeFor({ cwd: "C:/code/x", config: cfg }), MODE_ARMED);
  cfg.providers.claude.enabled = false;
  equal(await modeFor({ cwd: "C:/code/x", config: cfg }), MODE_UNARMED);
});

// The inheritance case a `Array.isArray(block.allowedRoots)` filter skips: no provider has
// a list of its own, so only the top-level key arms anything.
test("modeFor: a non-Claude provider inheriting the top-level list is armed", async () => {
  const cfg = {
    allowedRoots: ["C:/code"],
    providers: { claude: { enabled: true }, ollama: { enabled: true } },
  };
  equal(await modeFor({ cwd: "C:/code/x", config: cfg }), MODE_ARMED);
  equal(await modeFor({ cwd: "D:/work", config: cfg }), MODE_UNARMED);
  // The hook reads RAW config.json — no defaults merge — so a file that sets only the
  // top-level key must still arm the providers the plugin ships.
  equal(await modeFor({ cwd: "C:/code/x", config: { allowedRoots: ["C:/code"] } }), MODE_ARMED);
});
