import { test } from "node:test";
import { equal, ok, match } from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { decide, modeFor, standingBlock, MODE_CLOUD, MODE_ANTHROPIC } from "../hooks/ultraswarm.mjs";
import { normalizeOllama, normalizeAnthropic } from "../src/usage.mjs";

const armed = { swarm: { always: true }, provider: { allowedRoots: ["C:/code"] } };

test("decide: SessionStart arms only on swarm.always; UserPromptSubmit only on the keyword", async () => {
  equal(await decide({ event: "SessionStart", cwd: "C:/code/x", config: armed }), standingBlock(MODE_CLOUD));
  equal(await decide({ event: "SessionStart", cwd: "C:/code/x", config: { provider: armed.provider } }), null);
  equal(await decide({ event: "UserPromptSubmit", prompt: "please ULTRASWARM this", cwd: "C:/code/x", config: {} }), standingBlock(MODE_ANTHROPIC));
  equal(await decide({ event: "UserPromptSubmit", prompt: "ordinary prompt", cwd: "C:/code/x", config: armed }), null);
  // the keyword is a standalone word — a filename or path token never arms it
  for (const p of ["edit hooks/ultraswarm.mjs", "tests/ultraswarm.test.mjs failed", "see ultraswarm-notes"]) {
    equal(await decide({ event: "UserPromptSubmit", prompt: p, cwd: "C:/code/x", config: {} }), null, p);
  }
  equal(await decide({ event: "PreToolUse", prompt: "ultraswarm", cwd: "C:/code/x", config: armed }), null);
});

test("modeFor: cloud under an allowed root (either slash style, any case), Anthropic otherwise", async () => {
  const cfg = { provider: { allowedRoots: ["C:/code"] } };
  equal(await modeFor({ cwd: "C:/code/claude-plugin-marketplace", config: cfg }), MODE_CLOUD);
  equal(await modeFor({ cwd: "c:\\CODE\\primordial", config: cfg }), MODE_CLOUD);
  equal(await modeFor({ cwd: "C:/code", config: cfg }), MODE_CLOUD);
  equal(await modeFor({ cwd: "C:/codex/other", config: cfg }), MODE_ANTHROPIC);
  equal(await modeFor({ cwd: "D:/work", config: cfg }), MODE_ANTHROPIC);
  equal(await modeFor({ cwd: "C:/code/x", config: { provider: { allowedRoots: [] } } }), MODE_ANTHROPIC);
  equal(await modeFor({ cwd: "C:/code/x", config: null }), MODE_ANTHROPIC);
});

test("standingBlock mirrors the superpowers dispatcher: wrapped, pre-authorised, ceremony named, one mode bracket, no question", () => {
  for (const mode of [MODE_CLOUD, MODE_ANTHROPIC]) {
    const block = standingBlock(mode);
    match(block, /^<EXTREMELY_IMPORTANT>\n[\s\S]*\n<\/EXTREMELY_IMPORTANT>$/);
    ok(block.includes("PRE-AUTHORISED"));
    ok(block.includes("Skill(swarm)"));
    for (const step of ["orchestrating-agents", "executing-swarms", "models", "validate"]) ok(block.includes(step), step);
    equal((block.match(/\[[^\]]+\]/g) || []).length, 1, "exactly one mode bracket");
    ok(block.includes(mode));
    ok(!/AskUserQuestion/.test(block), "no question");
    ok(block.length < 800, `under 800 chars, got ${block.length}`);
  }
});

test("the hook never probes and reads no models cache — the block carries no model list", () => {
  const src = readFileSync(fileURLToPath(new URL("../hooks/ultraswarm.mjs", import.meta.url)), "utf8");
  ok(!src.includes("probeTopModels") && !src.includes("/api/generate"));
  ok(!src.includes("models-cache"), "no models-cache read");
});

const ALWAYS = { swarm: { always: true }, provider: { allowedRoots: ["C:/code"] } };
const dec = (reading) => decide({
  event: "SessionStart", cwd: "C:/code/x", config: ALWAYS,
  usage: reading ? [normalizeOllama(reading)] : [],
});
const OLLAMA = { sessionPctUsed: 10, sessionResetsAt: "S", weeklyPctUsed: 50, resetsAt: "W" };

test("decide: U1 RED — an exhausted provider names the reset, OUTSIDE the standing block", async () => {
  const out = await dec({ ...OLLAMA, state: "exhausted", weeklyPctUsed: 100, resetsAt: "2026-09-07T00:00:00Z" });
  ok(out.includes("2026-09-07T00:00:00Z"), out);
  // The block is instruction and ends where it ends; the usage line follows it.
  ok(out.startsWith(standingBlock(MODE_CLOUD) + "\n"), out);
  ok(out.endsWith("</EXTREMELY_IMPORTANT>") === false, out);
});

test("decide: U2 false-positive guard — a healthy provider emits the block and NOTHING else", async () => {
  equal(await dec({ ...OLLAMA, state: "ok" }), standingBlock(MODE_CLOUD));
});

test("modeFor: U3 governance decides the mode; the meter never touches it", async () => {
  equal(await modeFor({ cwd: "C:/codex/other", config: { provider: { allowedRoots: ["C:/code"] } } }), MODE_ANTHROPIC);
  equal(await modeFor({ cwd: "C:/code/x", config: { provider: { allowedRoots: [] } } }), MODE_ANTHROPIC);
  // An exhausted meter is availability, not preference — the bracket is unmoved.
  ok((await dec({ ...OLLAMA, state: "exhausted", weeklyPctUsed: 100 })).includes(`Mode: ${MODE_CLOUD}`));
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
  ok(cached.startsWith(standingBlock(MODE_CLOUD) + "\n"), cached);

  const live = await dec({ ...OLLAMA, provenance: "live" });
  ok(!live.includes("/!\\"), `a live reading prints no banner: ${live}`);
  equal(live, standingBlock(MODE_CLOUD), "no banner means no extra lines at all");
});

test("decide: U6 every notable provider gets its own lines", async () => {
  const out = await decide({
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
  equal(await modeFor({ cwd: "C:/code/x", config: cfg }), MODE_CLOUD);
  equal(await decide({ event: "SessionStart", cwd: "C:/code/x", config: { swarm: { always: true }, provider: cfg.provider } }), standingBlock(MODE_CLOUD));
});
