// Leaf MCP servers: the machine-wide `mcp.off` set, the per-repo `projects[].mcp.on`
// override, the tool-name route, the per-leaf `--settings.deniedMcpServers` and the
// digest/ask paths that carry them.
import "./helpers/isolate-home.mjs";
import { test } from "node:test";
import { deepEqual, equal, ok, throws } from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { leafMcpOff, toolPrefixFor, toolUsesServer } from "../src/leaf-mcp.mjs";
import { loadConfig } from "../src/config.mjs";
import { loadManifest } from "./helpers/repo-io.mjs";
import { buildDispatch } from "../src/dispatch.mjs";
import { buildDigestTask } from "../src/digest.mjs";
import { askLeaf } from "../src/ask.mjs";
import { initResultsDir, writeManifestSnapshot, writeResult } from "../src/results.mjs";
import { fakeSpawnFactory, makeIo, STREAM } from "./helpers/fake-io.mjs";
import { CFG, claudeTask, errorsOf, tmp, writeManifest } from "./helpers/manifest-fixtures.mjs";

const SLACK = "plugin:slack-bridge:slack-bridge-remote";

function tmpConfig(body) {
  const dir = mkdtempSync(join(tmpdir(), "swarm-mcp-cfg-"));
  const path = join(dir, "config.json");
  writeFileSync(path, JSON.stringify(body));
  return { dir, path };
}

function cfgErrors(fn) {
  try {
    fn();
  } catch (e) {
    return e.message;
  }
  throw new Error("expected loadConfig to throw");
}

// ── config surface ───────────────────────────────────────────────────────────

test("mcp: absent loads; wrong type, empty string and an unknown key are refused naming the key", () => {
  ok(loadConfig(tmpConfig({}).path).providers);
  const bad = (body, needle) => {
    const { dir, path } = tmpConfig(body);
    try {
      const message = cfgErrors(() => loadConfig(path));
      ok(message.includes(needle), message);
      ok(message.includes('"off"'), message);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };
  bad({ mcp: "blender" }, "mcp");
  bad({ mcp: { off: "blender" } }, "mcp.off");
  bad({ mcp: { off: [""] } }, "mcp.off");
  bad({ mcp: { deny: [] } }, "deny");
  const { dir, path } = tmpConfig({ mcp: { off: ["blender"] } });
  try {
    deepEqual(loadConfig(path).mcp, { off: ["blender"] });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("projects: an entry with only mcp.on loads; a bad mcp.on or an entry with neither is refused", () => {
  const loads = (projects) => {
    const { dir, path } = tmpConfig({ projects });
    try {
      return loadConfig(path).projects;
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };
  const messageFor = (projects) => {
    const { dir, path } = tmpConfig({ projects });
    try {
      return cfgErrors(() => loadConfig(path));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };
  deepEqual(loads([{ name: "rts-mobile", mcp: { on: ["blender"] } }]), [{ name: "rts-mobile", mcp: { on: ["blender"] } }]);
  deepEqual(loads([{ name: "guarded", hooks: { preToolUse: "cmd" } }]), [{ name: "guarded", hooks: { preToolUse: "cmd" } }]);
  ok(messageFor([{ name: "rts-mobile", mcp: { on: "blender" } }]).includes("projects[0].mcp.on"));
  ok(messageFor([{ name: "rts-mobile", mcp: { on: [""] } }]).includes("projects[0].mcp.on"));
  const neither = messageFor([{ name: "nothing" }]);
  ok(neither.includes("sets neither hooks nor mcp"), neither);
  ok(neither.includes('"mcp": {"on": ["blender"]}'), neither);
});

// ── tool names ──────────────────────────────────────────────────────────────

test("toolUsesServer matches forward only, on the real plugin tool name", () => {
  equal(toolPrefixFor("blender"), "mcp__blender");
  equal(toolPrefixFor(SLACK), "mcp__plugin_slack-bridge_slack-bridge-remote");
  equal(toolUsesServer("mcp__plugin_slack-bridge_slack-bridge-remote__send_message", SLACK), true);
  equal(toolUsesServer("mcp__blender", "blender"), true);
  equal(toolUsesServer("mcp__blender__execute_blender_code", "blender"), true);
  equal(toolUsesServer("mcp__blender__execute_blender_code(Bash)", "blender"), true);
  equal(toolUsesServer("mcp__blender_extra", "blender"), false);
  equal(toolUsesServer("Bash", "blender"), false);
});

// ── normalization: the off set per leaf ─────────────────────────────────────

const MCP_TOOLS = () => ["mcp__scout", "mcp__blender"];

// The repo a leaf "runs in" is a basename under the test dir, so the root gate
// accepts it and project matching sees the name the fixture asks for.
function planFor(dir, body, { repo = "plain-repo", cfg = CFG, mcpTools = MCP_TOOLS } = {}) {
  return loadManifest(writeManifest(dir, body), cfg, dir, {
    io: { repoToplevel: () => join(dir, repo), mcpTools },
  });
}

test("leafMcpOff: repo on and a named tool both subtract, sorted and de-duplicated", () => {
  const cfg = { mcp: { off: ["scout", SLACK, "blender", "blender"] } };
  deepEqual(leafMcpOff({ cfg, allowedTools: "" }), ["blender", SLACK, "scout"]);
  deepEqual(leafMcpOff({ cfg, project: { name: "rts-mobile", mcp: { on: ["blender"] } }, allowedTools: "" }), [SLACK, "scout"]);
  deepEqual(leafMcpOff({ cfg, allowedTools: "Read, mcp__scout__search" }), ["blender", SLACK]);
  deepEqual(leafMcpOff({ cfg: {}, allowedTools: "" }), []);
  deepEqual(leafMcpOff({ cfg: { mcp: { off: [] } }, allowedTools: "" }), []);
});

test("a leaf gets mcpOff minus its repo's on set; an unmatched repo keeps the full off list", () => {
  const dir = tmp();
  try {
    const cfg = { ...CFG, mcp: { off: ["blender", SLACK] }, projects: [{ name: "rts-mobile", mcp: { on: ["blender"] } }] };
    const body = { tasks: [claudeTask()] };
    deepEqual(planFor(dir, body, { repo: "rts-mobile", cfg }).tasks[0].mcpOff, [SLACK]);
    deepEqual(planFor(dir, body, { repo: "other-repo", cfg }).tasks[0].mcpOff, ["blender", SLACK]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("no mcp config, or an empty off list, leaves no mcpOff key at all", () => {
  const dir = tmp();
  try {
    const body = { tasks: [claudeTask()] };
    ok(!("mcpOff" in planFor(dir, body, { cfg: CFG }).tasks[0]));
    ok(!("mcpOff" in planFor(dir, body, { cfg: { ...CFG, mcp: { off: [] }, projects: [] } }).tasks[0]));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("naming a server's tool turns it on for that leaf only, with no validate error", () => {
  const dir = tmp();
  try {
    const plan = planFor(dir, {
      tasks: [
        claudeTask({ id: "a", allowedTools: "Read,Grep,mcp__blender__execute_blender_code" }),
        claudeTask({ id: "b" }),
      ],
    }, { cfg: { ...CFG, mcp: { off: ["blender", SLACK] } } });
    const byId = (id) => plan.tasks.find((t) => t.id === id);
    deepEqual(byId("a").mcpOff, [SLACK]);
    deepEqual(byId("b").mcpOff, ["blender", SLACK]);
    equal(byId("a").allowedTools, "Read,Grep,mcp__blender__execute_blender_code");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the default allowedTools omits off servers and keeps the rest", () => {
  const dir = tmp();
  try {
    const plan = planFor(dir, { tasks: [claudeTask()] }, { cfg: { ...CFG, mcp: { off: ["blender"] } } });
    const tools = plan.tasks[0].allowedTools.split(",");
    ok(tools.includes("mcp__scout"), plan.tasks[0].allowedTools);
    ok(!tools.includes("mcp__blender"), plan.tasks[0].allowedTools);
    const authored = planFor(dir, { tasks: [claudeTask({ allowedTools: "Read" })] }, { cfg: { ...CFG, mcp: { off: ["blender"] } } });
    equal(authored.tasks[0].allowedTools, "Read");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a typo'd off or on name warns once, in a top-level and in a child manifest", () => {
  const dir = tmp();
  try {
    const cfg = { ...CFG, mcp: { off: ["blendr"] } };
    const top = planFor(dir, { tasks: [claudeTask()] }, { cfg });
    equal(top.warnings.filter((w) => w.includes("blendr")).length, 1);
    ok(top.warnings.find((w) => w.includes("blendr")).includes("mcp.off"));

    writeFileSync(join(dir, "child.json"), JSON.stringify({ tasks: [claudeTask({ id: "child" })] }));
    const onCfg = { ...CFG, mcp: { off: ["blender"] }, projects: [{ name: "plain-repo", mcp: { on: ["blendr"] } }] };
    const parent = planFor(dir, { tasks: [{ id: "node", manifest: "child.json" }] }, { cfg: onCfg });
    equal(parent.warnings.filter((w) => w.includes("blendr")).length, 1);
    ok(parent.warnings.find((w) => w.includes("blendr")).includes("projects[].mcp.on"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── dispatch: the per-leaf --settings channel ───────────────────────────────

const DISPATCH_CFG = {
  provider: { mode: "env", url: "http://localhost:11434", authToken: "ollama", launchCmd: "ollama launch claude --model {model} -- {args}" },
  providers: {
    claude: { enabled: true, allowedRoots: [tmpdir()] },
    ollama: { enabled: true, allowedRoots: [tmpdir()] },
    codex: { enabled: true, path: "codex", sandbox: "workspace-write", allowedRoots: [tmpdir()] },
  },
  disable1mContext: false,
};

const dispatchTask = (over = {}) => ({
  id: "t", provider: "claude", model: "claude-haiku-4-5-20251001", effort: "medium", allowedTools: "Read",
  cwd: tmpdir(), originalCwd: tmpdir(), ...over,
});

function settingsOf(dispatch) {
  const i = dispatch.argv.indexOf("--settings");
  return i < 0 ? null : JSON.parse(dispatch.argv[i + 1]);
}

test("dispatch: claude, ollama env and ollama launch all carry deniedMcpServers beside their own settings", () => {
  const mcpOff = ["blender", SLACK];
  const denied = [{ serverName: "blender" }, { serverName: SLACK }];
  const claude = buildDispatch(dispatchTask({ mcpOff, contextWindow: "1m" }), "p", DISPATCH_CFG);
  deepEqual(settingsOf(claude).deniedMcpServers, denied);
  deepEqual(settingsOf(claude).env, { CLAUDE_CODE_DISABLE_1M_CONTEXT: "0" });

  const envMode = buildDispatch(dispatchTask({ provider: "ollama", model: "glm-4.6:cloud", mcpOff }), "p", DISPATCH_CFG);
  deepEqual(settingsOf(envMode).deniedMcpServers, denied);
  equal(envMode.env.ANTHROPIC_MODEL, "glm-4.6:cloud");

  const launchCfg = { ...DISPATCH_CFG, provider: { ...DISPATCH_CFG.provider, mode: "launch" } };
  const launch = buildDispatch(dispatchTask({ provider: "ollama", model: "glm-4.6:cloud", mcpOff }), "p", launchCfg);
  deepEqual(settingsOf(launch).deniedMcpServers, denied);
  ok(launch.argv.includes("{args}") === false && launch.argv.includes("-p"));
});

test("dispatch: a task's own settings.env rides beside the engine's denied list", () => {
  const d = buildDispatch(dispatchTask({ mcpOff: ["blender"], settings: { env: { FOO: "1" } } }), "p",
    { ...DISPATCH_CFG, disable1mContext: true });
  deepEqual(settingsOf(d), { env: { FOO: "1" }, deniedMcpServers: [{ serverName: "blender" }] });
});

test("dispatch: no mcpOff leaves the argv exactly as before, and codex ignores it", () => {
  const plainCfg = { ...DISPATCH_CFG, disable1mContext: true };
  const plain = buildDispatch(dispatchTask(), "p", plainCfg);
  equal(settingsOf(plain), null);
  deepEqual(plain.argv, [
    "claude", "-p", "p", "--model", "claude-haiku-4-5-20251001", "--effort", "medium",
    "--allowedTools", "Read", "--output-format", "stream-json", "--verbose",
  ]);
  const codex = dispatchTask({ provider: "codex", model: "gpt-5-codex", cwd: tmpdir(), originalCwd: tmpdir() });
  deepEqual(
    buildDispatch({ ...codex, mcpOff: ["blender"] }, "p", DISPATCH_CFG).argv,
    buildDispatch(codex, "p", DISPATCH_CFG).argv,
  );
});

test("a task's own deniedMcpServers is refused, naming both real routes", () => {
  const dir = tmp();
  try {
    const errs = errorsOf(() => planFor(dir, {
      tasks: [claudeTask({ settings: { deniedMcpServers: [{ serverName: "scout" }] } })],
    }));
    const message = errs.join("|");
    ok(message.includes("deniedMcpServers"), message);
    ok(message.includes("allowedTools"), message);
    ok(message.includes("mcp") && message.includes("on"), message);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("with validation bypassed, the task's own denied list cannot displace the engine's", () => {
  const d = buildDispatch(dispatchTask({
    mcpOff: ["blender"],
    settings: { deniedMcpServers: [{ serverName: "scout" }] },
  }), "p", DISPATCH_CFG);
  deepEqual(settingsOf(d).deniedMcpServers, [{ serverName: "blender" }]);
});

test("a codex task with a claude fallback is stamped, and its fallback argv carries the list", () => {
  const dir = tmp();
  try {
    const cfg = { ...CFG, mcp: { off: ["blender"] }, providers: { ...CFG.providers, codex: { enabled: true, allowedRoots: [tmpdir()] } } };
    const plan = planFor(dir, {
      tasks: [{ id: "c", prompt: "inspect", provider: "codex", model: "gpt-5-codex", fallbackProvider: "claude", fallbackModel: "claude-haiku-4-5-20251001" }],
    }, { cfg });
    deepEqual(plan.tasks[0].mcpOff, ["blender"]);
    const flipped = buildDispatch({ ...plan.tasks[0], provider: "claude", model: plan.tasks[0].fallbackModel }, "p", cfg);
    deepEqual(settingsOf(flipped).deniedMcpServers, [{ serverName: "blender" }]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── digest and ask ──────────────────────────────────────────────────────────

test("the digest carries the dispatching repo's set, at validate and at run time", () => {
  const dir = tmp();
  try {
    const cfg = { ...CFG, mcp: { off: ["blender", SLACK] }, projects: [{ name: "rts-mobile", mcp: { on: ["blender"] } }] };
    const plan = planFor(dir, {
      tasks: [claudeTask()],
      digest: { provider: "claude", model: "claude-haiku-4-5-20251001" },
    }, { cfg, repo: "rts-mobile" });
    deepEqual(plan.mcpOff, [SLACK]);
    // The scheduler rebuilds the digest task from the loaded plan.
    deepEqual(buildDigestTask(plan).mcpOff, [SLACK]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("swarm ask rebuilds mcpOff from the current config through _projectFor", async () => {
  const dir = mkdtempSync(join(tmpdir(), "swarm-mcp-ask-"));
  try {
    initResultsDir(dir);
    writeResult(dir, "leaf", {
      id: "leaf", provider: "claude", model: "claude-haiku-4-5-20251001", ok: true, exit: 0, durationMs: 5,
      output: "x", sessionId: "s-1", cwd: tmpdir(), originalCwd: tmpdir(), allowedTools: "Read,Grep",
    });
    writeManifestSnapshot(dir, { cwd: tmpdir(), resultsDir: dir, tasks: [{ id: "leaf", provider: "claude", model: "claude-haiku-4-5-20251001" }] });
    const spawn = fakeSpawnFactory(() => ({ output: STREAM }));
    const cfg = { ...CFG, mcp: { off: ["blender", SLACK] } };
    let askedCwd;
    await askLeaf({
      resultsDir: dir, taskId: "leaf", question: "q", cfg, io: makeIo(spawn),
      _projectFor: (cwd) => {
        askedCwd = cwd;
        return { project: { name: "rts-mobile", mcp: { on: ["blender"] } }, repoName: "rts-mobile" };
      },
    });
    equal(askedCwd, tmpdir());
    const args = spawn.calls[0].args;
    deepEqual(JSON.parse(args[args.indexOf("--settings") + 1]).deniedMcpServers, [{ serverName: SLACK }]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
