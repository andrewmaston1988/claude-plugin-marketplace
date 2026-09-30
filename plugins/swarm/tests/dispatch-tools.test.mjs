import { test } from "node:test";
import { equal } from "node:assert/strict";
import { buildDispatch } from "../src/dispatch.mjs";

const CFG = { provider: { mode: "env", url: "http://localhost:11434", authToken: "ollama" } };
const task = (over = {}) => ({
  id: "t", provider: "claude", model: "claude-haiku-4-5-20251001", effort: "medium", allowedTools: "Read,Grep,Glob", ...over,
});

const toolsOf = (d) => d.argv[d.argv.indexOf("--allowedTools") + 1].split(",");

// Dispatch adds ONE name to an authored list — the tool the engine's own
// --json-schema creates. Skill and the MCP servers are a normalize-time DEFAULT
// for a Claude-runner leaf (default-tools.test.mjs), so an author who names a list
// overrides them too and argv carries exactly what the task had.
test("a named list reaches --allowedTools verbatim: no Skill, no MCP, for Claude and Ollama alike", () => {
  for (const over of [
    { allowedTools: "Read,Grep" },
    { allowedTools: "Read,Bash" },
    { provider: "ollama", model: "minimax-m3:cloud", allowedTools: "Read" },
  ]) {
    const d = buildDispatch(task(over), "p", CFG);
    equal(d.argv[d.argv.indexOf("--allowedTools") + 1], over.allowedTools, JSON.stringify(over));
  }
});

// --json-schema hands a `returns` leaf a StructuredOutput tool; off bypass mode an unlisted tool is denied.
test("a returns leaf may call StructuredOutput once; a leaf without returns is not offered it", () => {
  for (const over of [{ returns: { type: "object" } }, { returns: { type: "object" }, allowedTools: "Read,StructuredOutput" }]) {
    const tools = toolsOf(buildDispatch(task(over), "p", CFG));
    equal(tools.filter((t) => t === "StructuredOutput").length, 1, `${JSON.stringify(over)} → ${tools}`);
  }
  equal(toolsOf(buildDispatch(task(), "p", CFG)).includes("StructuredOutput"), false);
});
