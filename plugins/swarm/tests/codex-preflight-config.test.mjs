import { test } from "node:test";
import { equal } from "node:assert/strict";
import { createCodexProviderAdapter } from "../src/codex.mjs";

test("quotaPreflight false skips Codex usage preflight without spawning", async () => {
  let spawned = false;
  const adapter = createCodexProviderAdapter({ spawnImpl() { spawned = true; throw new Error("must not spawn"); } });
  const result = await adapter.capabilities.preflight({
    config: { quotaPreflight: false, providers: { codex: { enabled: true } } },
  });
  equal(result.ok, true);
  equal(spawned, false);
});
