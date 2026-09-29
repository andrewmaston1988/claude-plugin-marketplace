import { test } from "node:test";
import { equal, deepEqual } from "node:assert/strict";
import { buildDispatch, mcpTools } from "../src/dispatch.mjs";

// What every Claude-runner leaf may call beyond its own list: the operator's MCP servers and Skill.
const NO_MCP = () => [];
const CFG = { provider: { mode: "env", url: "http://localhost:11434", authToken: "ollama" } };
const task = (over = {}) => ({
  id: "t", provider: "claude", model: "claude-haiku-4-5-20251001", effort: "medium", allowedTools: "Read,Grep,Glob", ...over,
});

test("mcpTools names each configured server; a wildcard would grant nothing", () => {
  const read = () => JSON.stringify({ mcpServers: { scout: {}, context7: {} } });
  deepEqual(mcpTools(read), ["mcp__scout", "mcp__context7"]);
});

test("mcpTools is empty when the file is missing, unreadable or has no servers", () => {
  deepEqual(mcpTools(() => { throw new Error("ENOENT"); }), []);
  deepEqual(mcpTools(() => "not json"), []);
  deepEqual(mcpTools(() => JSON.stringify({})), []);
});

test("every leaf's allowedTools carries the MCP servers", () => {
  const fake = () => ["mcp__scout"];
  const d = buildDispatch({ provider: "claude", model: "claude-sonnet-5", allowedTools: "Read,Grep" }, "p", CFG, { _mcpTools: fake });
  equal(d.argv[d.argv.indexOf("--allowedTools") + 1], "Read,Grep,Skill,mcp__scout");
});

test("a leaf with no allowedTools still gets Skill and MCP, with no leading comma", () => {
  const fake = () => ["mcp__scout"];
  const d = buildDispatch({ provider: "claude", model: "claude-sonnet-5", allowedTools: "" }, "p", CFG, { _mcpTools: fake });
  equal(d.argv[d.argv.indexOf("--allowedTools") + 1], "Skill,mcp__scout");
});

// Skill goes to every Claude-runner leaf, whatever list its author wrote: skills are
// the operator's own tooling, like the MCP servers beside them.
const toolsOf = (d) => d.argv[d.argv.indexOf("--allowedTools") + 1].split(",");
test("every Claude-runner leaf may invoke Skill: default, explicit write list, and Ollama", () => {
  for (const over of [{}, { allowedTools: "Read,Edit,Bash" }, { provider: "ollama", model: "minimax-m3:cloud" }]) {
    const tools = toolsOf(buildDispatch(task(over), "p", CFG, { _mcpTools: NO_MCP }));
    equal(tools.filter((t) => t === "Skill").length, 1, `${JSON.stringify(over)} → ${tools}`);
  }
});

test("an author who already lists Skill gets it once", () => {
  const tools = toolsOf(buildDispatch(task({ allowedTools: "Read,Skill" }), "p", CFG, { _mcpTools: NO_MCP }));
  deepEqual(tools, ["Read", "Skill"]);
});
