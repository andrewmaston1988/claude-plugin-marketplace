import { test } from "node:test";
import assert from "node:assert/strict";
import { renderManifest } from "../src/setup/manifest.mjs";

function botScopes(yaml) {
  const block = yaml.match(/^ {4}bot:\n((?: {6}- .+\n)+)/m);
  assert.ok(block, "manifest has an oauth_config.scopes.bot list");
  return block[1].split("\n").filter(Boolean).map((l) => l.trim().slice(2));
}

test("bot scopes include channels:join so seizing an existing channel can join it", () => {
  assert.ok(botScopes(renderManifest()).includes("channels:join"));
});
