// Every hook builds a broker client, so the client's module graph is paid on every
// tool call: it must never reach the broker server and its node:http.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const src = fileURLToPath(new URL("../../src/remote/", import.meta.url));

function reachable(file, seen = new Set()) {
  if (seen.has(file)) return seen;
  seen.add(file);
  const code = fs.readFileSync(file, "utf8");
  for (const [, rel] of code.matchAll(/^\s*(?:import|export)\b[^;]*?from\s+"(\.[^"]+)"/gm)) {
    reachable(path.resolve(path.dirname(file), rel), seen);
  }
  return seen;
}

test("the broker client never imports the broker server", () => {
  const graph = [...reachable(path.join(src, "broker-client.mjs"))].map((f) => path.basename(f));
  assert.ok(graph.includes("broker-kinds.mjs"), JSON.stringify(graph));
  assert.ok(!graph.includes("broker.mjs"), JSON.stringify(graph));
});
