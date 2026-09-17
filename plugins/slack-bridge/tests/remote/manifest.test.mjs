// The 2026-07-21 operator reversal ("claude-peers works. do what that does")
// directs the remote-mcp server to be declared in the plugin manifest, exactly
// as claude-peers declares its own. The reversal-era edit never reached the
// branch — this pin exists so it cannot silently vanish again: without the
// declaration the server only loads via the wizard's user-scoped step, and
// sessions that never ran the wizard get no remote-control tools at all.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

const pluginJson = JSON.parse(
  fs.readFileSync(fileURLToPath(new URL("../../.claude-plugin/plugin.json", import.meta.url)), "utf8"),
);

test("plugin manifest declares the remote-mcp server, mirroring claude-peers", () => {
  assert.ok(pluginJson.mcpServers, "mcpServers must exist in the plugin manifest");
  const server = pluginJson.mcpServers["slack-bridge-remote"];
  assert.ok(server, "mcpServers must name slack-bridge-remote");
  assert.equal(server.command, "node");
  assert.deepEqual(server.args, ["${CLAUDE_PLUGIN_ROOT}/bin/claude-slack.mjs", "remote-mcp"]);
});