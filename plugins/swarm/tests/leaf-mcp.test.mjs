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
