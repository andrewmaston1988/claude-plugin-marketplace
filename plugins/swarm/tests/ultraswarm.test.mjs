import { test } from "node:test";
import { equal, ok, match } from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { decide, modeFor, standingBlock, MODE_CLOUD, MODE_ANTHROPIC } from "../hooks/ultraswarm.mjs";

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
    ok(block.length < 700, `under 700 chars, got ${block.length}`);
  }
});

test("the hook never probes and reads no models cache — the block carries no model list", () => {
  const src = readFileSync(fileURLToPath(new URL("../hooks/ultraswarm.mjs", import.meta.url)), "utf8");
  ok(!src.includes("probeTopModels") && !src.includes("/api/generate"));
  ok(!src.includes("models-cache"), "no models-cache read");
});
