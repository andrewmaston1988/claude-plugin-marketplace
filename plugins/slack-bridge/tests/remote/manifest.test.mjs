// Pins the manifest declaration of the remote-mcp server (the claude-peers
// pattern): without the mcpServers entry, plugin-installed sessions never
// load the remote-control tools.
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
