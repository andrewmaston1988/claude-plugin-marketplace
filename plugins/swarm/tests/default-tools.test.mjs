// The leaf toolset an author does not name, and what naming one replaces.
//
// A Claude-runner leaf (Claude or Ollama — both dispatch the claude CLI) defaults to
// the read-only trio plus `Skill` and every configured MCP server: off bypass
// permissions an unlisted tool is DENIED, so those are the operator's own tooling
// being kept reachable. A Codex leaf gets the trio alone — Codex has no Skill tool,
// reads its MCP servers from its own config, and uses allowedTools only to pick a
// sandbox. Naming a list replaces the default completely; dispatch adds nothing to
// it but `StructuredOutput` (dispatch-tools.test.mjs).
import { test } from "node:test";
import { equal, deepEqual } from "node:assert/strict";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { defaultToolsFor, mcpTools } from "../src/manifest-task-policy.mjs";
import { effectivePlanDoc } from "../src/manifest.mjs";
import { buildDispatch } from "../src/dispatch.mjs";
import { loadManifest } from "./helpers/repo-io.mjs";
import { CFG, writeManifest, tmp, claudeTask } from "./helpers/manifest-fixtures.mjs";

const MCP = ["mcp__x"];
// The default is computed at normalize from THIS machine's servers, so every pin
// stubs the reader: isolate-home sets SWARM_HOME only, and the real `mcpTools`
// reads ~/.claude.json.
const stubMcp = { io: { mcpTools: () => MCP } };
// No allowedRoots anywhere, so dispatch's root gate stays off — these pins are
// about the tool list, not governance.
const DISPATCH_CFG = { provider: { mode: "env", url: "http://localhost:11434", authToken: "ollama" } };

test("defaultToolsFor: Claude and Ollama carry Skill + every MCP server; Codex carries neither", () => {
  equal(defaultToolsFor("claude", MCP), "Read,Grep,Glob,Skill,mcp__x");
  equal(defaultToolsFor("ollama", MCP), "Read,Grep,Glob,Skill,mcp__x");
  equal(defaultToolsFor("codex", MCP), "Read,Grep,Glob");
});

test("mcpTools names each configured server; a wildcard would grant nothing", () => {
  deepEqual(mcpTools(() => JSON.stringify({ mcpServers: { scout: {}, context7: {} } })), ["mcp__scout", "mcp__context7"]);
});

test("mcpTools is empty when the file is missing, unreadable or has no servers", () => {
  deepEqual(mcpTools(() => { throw new Error("ENOENT"); }), []);
  deepEqual(mcpTools(() => "not json"), []);
  deepEqual(mcpTools(() => JSON.stringify({})), []);
});

test("normalize: a Claude task with no allowedTools gets the read-only trio, Skill and the MCP servers", () => {
  const dir = tmp();
  try {
    const p = writeManifest(dir, { tasks: [claudeTask()] });
    equal(loadManifest(p, CFG, dir, stubMcp).tasks[0].allowedTools, "Read,Grep,Glob,Skill,mcp__x");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("normalize: an Ollama task gets the same default — it runs the claude CLI too", () => {
  const dir = tmp();
  try {
    const cfg = { ...CFG, providers: { claude: { enabled: true }, ollama: { enabled: true, allowedRoots: [dir] } } };
    const p = writeManifest(dir, { tasks: [{ id: "a", prompt: "inspect", provider: "ollama", model: "glm-4.6:cloud" }] });
    equal(loadManifest(p, cfg, dir, stubMcp).tasks[0].allowedTools, "Read,Grep,Glob,Skill,mcp__x");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("normalize: a Codex task gets the read-only trio alone — no Skill tool, its own MCP config", () => {
  const dir = tmp();
  try {
    const cfg = { ...CFG, providers: { claude: { enabled: true }, codex: { enabled: true, allowedRoots: [dir] } } };
    const p = writeManifest(dir, { tasks: [{ id: "a", prompt: "inspect", provider: "codex", model: "gpt-5-codex" }] });
    equal(loadManifest(p, cfg, dir, stubMcp).tasks[0].allowedTools, "Read,Grep,Glob");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("normalize: naming a list replaces the default — nothing is added to it", () => {
  const dir = tmp();
  try {
    const p = writeManifest(dir, { tasks: [claudeTask({ allowedTools: "Read,Bash" })] });
    equal(loadManifest(p, CFG, dir, stubMcp).tasks[0].allowedTools, "Read,Bash");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// The list is still trimmed and de-duplicated on its way to argv; what changed is
// that nothing else joins it.
test("dispatch: a named list reaches --allowedTools trimmed and de-duplicated, with nothing added", () => {
  const d = buildDispatch(
    { provider: "claude", model: "claude-sonnet-5", effort: "medium", allowedTools: " Read , Bash ,Read" },
    "p", DISPATCH_CFG
  );
  equal(d.argv[d.argv.indexOf("--allowedTools") + 1], "Read,Bash");
});

// scheduler.mjs writes the run's manifest.json from effectivePlanDoc, so this is
// the list the snapshot records — and therefore the list the leaf actually got.
test("snapshot: the run's recorded plan carries the filled-in default, not an authored blank", () => {
  const dir = tmp();
  try {
    const p = writeManifest(dir, { resultsDir: join(dir, "out"), tasks: [claudeTask()] });
    const plan = loadManifest(p, CFG, dir, stubMcp);
    equal(effectivePlanDoc(plan).tasks[0].allowedTools, "Read,Grep,Glob,Skill,mcp__x");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
